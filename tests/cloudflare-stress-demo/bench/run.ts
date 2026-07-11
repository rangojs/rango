/**
 * Bench harness entry point.
 *
 * Design constraints (see BENCHMARK.md "Methodology"):
 * - Scenarios run `--runs` times each, interleaved round-robin so thermal /
 *   background drift spreads across scenarios instead of biasing later ones.
 * - Every scenario declares an expected status; a response outside it FAILS
 *   the benchmark rather than being averaged into the numbers.
 * - Unique-path scenarios cycle distinct paths to defeat the router's
 *   single-entry pathname cache; fixed scenarios measure the pipeline floor.
 * - Cold start is measured on fresh server processes with TCP-only readiness
 *   (no HTTP request before the first measured one).
 * - Servers are spawned via ./node_modules/.bin/* directly: the repo's pnpm
 *   verifyDepsBeforeRun hook breaks `pnpm <script>` locally.
 */
import { execSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import autocannon from "autocannon";
import {
  coldStartPaths,
  resolvePaths,
  scenarios,
  timingPaths,
  warmupPaths,
  type BenchScenario,
} from "./scenarios.js";
import {
  binPath,
  startDevServer,
  startProdServer,
  getGroupRssKb,
  startRssPolling,
  type Server,
} from "./server.js";
import {
  aggregate,
  formatMarkdown,
  median,
  type BenchmarkResult,
  type BuildSizes,
  type ColdStartResult,
  type RunSample,
  type ThroughputResult,
  type TimingResult,
} from "./format.js";

const CWD = path.resolve(import.meta.dirname, "..");

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "production" },
    /**
     * Bench a REMOTE deployment (e.g. the deployed workers.dev URL) instead
     * of spawning a local server. Skips build, cold-restart phase, and RSS
     * (no local process). Run it right after `wrangler deploy` and the
     * one-shot "edge first hits" pass catches genuinely cold isolates.
     * Numbers include network RTT from this machine — comparative across
     * scenarios (same RTT baseline), and the only source of absolute
     * edge-adjacent latency we have.
     */
    url: { type: "string" },
    runs: { type: "string", default: "5" },
    duration: { type: "string", default: "5" },
    connections: { type: "string", default: "10" },
    warmup: { type: "string", default: "50" },
    "cold-runs": { type: "string", default: "5" },
    "skip-cold": { type: "boolean", default: false },
    "skip-throughput": { type: "boolean", default: false },
    baseline: { type: "boolean", default: false },
  },
});

const remoteUrl = args.url?.replace(/\/$/, "");
if (!remoteUrl && args.mode !== "dev" && args.mode !== "production") {
  console.error(
    `Invalid --mode "${args.mode}": expected "dev" or "production".`,
  );
  process.exit(1);
}
const mode = (remoteUrl ? "edge" : args.mode) as "dev" | "production" | "edge";
const runs = parseInt(args.runs!, 10);
const duration = parseInt(args.duration!, 10);
const connections = parseInt(args.connections!, 10);
const warmupCount = parseInt(args.warmup!, 10);
const coldRuns = parseInt(args["cold-runs"]!, 10);

if (mode === "dev") {
  console.warn(
    "\nWARNING: dev mode benches the Vite dev pipeline (transforms, dev React),",
  );
  console.warn("not the router product. Use dev mode as a smoke test only.\n");
}

// -- Metadata --

function getMeta(serverCommand: string) {
  const commit = execSync("git rev-parse --short HEAD", { cwd: CWD })
    .toString()
    .trim();
  let dirty = false;
  try {
    execSync("git diff --quiet HEAD", { cwd: CWD });
  } catch {
    dirty = true;
  }

  let cpu = `${process.arch}`;
  let cores = 0;
  let ramGb = 0;
  try {
    if (process.platform === "darwin") {
      cpu = execSync("sysctl -n machdep.cpu.brand_string").toString().trim();
      cores = parseInt(execSync("sysctl -n hw.ncpu").toString().trim(), 10);
      ramGb =
        parseInt(execSync("sysctl -n hw.memsize").toString().trim(), 10) /
        1024 ** 3;
    } else {
      const cpuInfo = execSync(
        "lscpu 2>/dev/null || cat /proc/cpuinfo 2>/dev/null | head -30",
      ).toString();
      const modelMatch = cpuInfo.match(/Model name:\s*(.+)/);
      if (modelMatch) cpu = modelMatch[1].trim();
      const coreMatch = cpuInfo.match(/CPU\(s\):\s*(\d+)/);
      if (coreMatch) cores = parseInt(coreMatch[1], 10);
      const mem = execSync(
        "cat /proc/meminfo 2>/dev/null | grep MemTotal",
      ).toString();
      const memMatch = mem.match(/(\d+)/);
      if (memMatch) ramGb = parseInt(memMatch[1], 10) / (1024 * 1024);
    }
  } catch {}

  return {
    date: new Date().toISOString().slice(0, 10),
    commit,
    dirty,
    mode,
    serverCommand,
    runs,
    duration,
    connections,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu,
    cores,
    ramGb: Math.round(ramGb),
  };
}

// -- Bundle sizes --

function collectDirSize(dir: string): {
  totalBytes: number;
  jsBytes: number;
  cssBytes: number;
} {
  let totalBytes = 0;
  let jsBytes = 0;
  let cssBytes = 0;
  try {
    const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(entry.parentPath, entry.name);
      const size = statSync(fullPath).size;
      totalBytes += size;
      if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))
        jsBytes += size;
      if (entry.name.endsWith(".css")) cssBytes += size;
    }
  } catch {
    // Directory may not exist
  }
  return { totalBytes, jsBytes, cssBytes };
}

function collectBuildSizes(buildTimeMs: number): BuildSizes {
  const dist = path.join(CWD, "dist");
  const client = collectDirSize(path.join(dist, "client"));
  const rsc = collectDirSize(path.join(dist, "rsc"));
  const ssr = collectDirSize(path.join(dist, "ssr"));
  return {
    client,
    rsc: { totalBytes: rsc.totalBytes },
    ssr: { totalBytes: ssr.totalBytes },
    total: client.totalBytes + rsc.totalBytes + ssr.totalBytes,
    buildTimeMs,
  };
}

// -- Fetch helpers --

async function timedFetch(
  url: string,
  headers?: Record<string, string>,
  init?: { method?: string; body?: string },
): Promise<{
  status: number;
  ms: number;
  bodyBytes: number;
  body: string;
  contentType: string;
}> {
  const start = performance.now();
  const res = await fetch(url, { headers, ...init });
  const body = await res.text();
  const ms = performance.now() - start;
  return {
    status: res.status,
    ms,
    bodyBytes: body.length,
    body,
    contentType: res.headers.get("content-type") ?? "",
  };
}

/**
 * Resolve scenarios with a `prepare` hook against the live server (e.g. the
 * action-post scenario scrapes its build-dependent $ACTION_ID field). A
 * scenario whose preparation fails is dropped with a warning rather than
 * benching garbage.
 */
async function prepareScenarios(baseUrl: string): Promise<BenchScenario[]> {
  const prepared: BenchScenario[] = [];
  for (const scenario of scenarios) {
    if (!scenario.prepare) {
      prepared.push(scenario);
      continue;
    }
    const extra = await scenario.prepare(baseUrl).catch(() => null);
    if (extra === null) {
      console.warn(
        `  WARNING: ${scenario.name} preparation failed; skipping scenario`,
      );
      continue;
    }
    prepared.push({ ...scenario, ...extra });
  }
  return prepared;
}

// -- Cold start --

async function runColdPhase(): Promise<ColdStartResult[]> {
  const byPath = new Map<string, number[]>();
  for (const c of coldStartPaths) byPath.set(c.path, []);

  for (let i = 0; i < coldRuns; i++) {
    process.stdout.write(`  cold run ${i + 1}/${coldRuns} ...`);
    const server = await startProdServer(CWD, { cold: true });
    try {
      for (const c of coldStartPaths) {
        const r = await timedFetch(`http://localhost:${server.port}${c.path}`, {
          accept: c.path === "/" ? "text/html" : "*/*",
        });
        if (r.status !== 200) {
          throw new Error(
            `Cold-start request ${c.path} returned ${r.status} (expected 200)`,
          );
        }
        byPath.get(c.path)!.push(r.ms);
      }
      console.log(" ok");
    } finally {
      await server.kill();
    }
  }

  return coldStartPaths.map((c) => {
    const runsMs = byPath.get(c.path)!;
    const agg = aggregate(runsMs);
    return {
      path: c.path,
      description: c.description,
      runsMs: runsMs.map((v) => parseFloat(v.toFixed(2))),
      medianMs: agg.median,
      minMs: agg.min,
      maxMs: agg.max,
    };
  });
}

// -- Validation --

async function validateScenarios(baseUrl: string, list: BenchScenario[]) {
  // Validation fetches carry no measurement, so they run concurrently —
  // unlike warmup/cold/timing collection, which are deliberately serial.
  const checks = list.flatMap((scenario) =>
    resolvePaths(scenario, "validate")
      .slice(0, 3)
      .map(async (p): Promise<string | null> => {
        try {
          const r = await timedFetch(`${baseUrl}${p}`, scenario.headers, {
            method: scenario.method ?? "GET",
            body: scenario.body,
          });
          if (r.status !== scenario.expectStatus) {
            return `${scenario.name}: ${p} returned ${r.status}, expected ${scenario.expectStatus}`;
          }
          if (scenario.expectBody && !r.body.includes(scenario.expectBody)) {
            return `${scenario.name}: ${p} body missing "${scenario.expectBody}"`;
          }
          if (
            scenario.expectContentType &&
            !r.contentType.startsWith(scenario.expectContentType)
          ) {
            return `${scenario.name}: ${p} content-type "${r.contentType}", expected "${scenario.expectContentType}"`;
          }
          return null;
        } catch (err) {
          return `${scenario.name}: ${p} fetch failed: ${err}`;
        }
      }),
  );
  const failures = (await Promise.all(checks)).filter(
    (f): f is string => f !== null,
  );
  if (failures.length > 0) {
    console.error("\nScenario validation FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    throw new Error(
      "Refusing to benchmark: scenarios do not return their expected responses.",
    );
  }
}

// -- Warmup --

async function warmup(baseUrl: string, list: BenchScenario[]) {
  console.log(`  Triggering lazy includes...`);
  for (const p of warmupPaths) {
    const res = await fetch(`${baseUrl}${p}`);
    if (res.status !== 200) {
      throw new Error(`Warmup request ${p} returned ${res.status}`);
    }
    await res.arrayBuffer();
  }

  console.log(`  Warming each scenario (~${warmupCount} requests each)...`);
  for (const scenario of list) {
    const resolved = resolvePaths(scenario, "warmup");
    const paths =
      scenario.kind === "unique"
        ? resolved.slice(0, Math.min(warmupCount, resolved.length))
        : Array.from({ length: warmupCount }, () => scenario.path);
    for (const p of paths) {
      const res = await fetch(`${baseUrl}${p}`, {
        headers: scenario.headers,
        method: scenario.method ?? "GET",
        body: scenario.body,
      });
      if (res.status !== scenario.expectStatus) {
        throw new Error(
          `Warmup for ${scenario.name}: ${p} returned ${res.status}, expected ${scenario.expectStatus}`,
        );
      }
      await res.arrayBuffer();
    }
  }
}

// -- Throughput --

function statusClass(result: Record<string, unknown>, cls: string): number {
  const v = result[cls];
  return typeof v === "number" ? v : 0;
}

async function runScenarioOnce(
  baseUrl: string,
  scenario: BenchScenario,
  nonce: string,
): Promise<RunSample> {
  const options: autocannon.Options =
    scenario.kind === "unique"
      ? {
          url: baseUrl,
          connections,
          duration,
          requests: resolvePaths(scenario, nonce).map((p) => ({
            method: (scenario.method ?? "GET") as "GET",
            path: p,
            headers: scenario.headers,
            body: scenario.body,
          })),
        }
      : {
          url: `${baseUrl}${scenario.path}`,
          connections,
          duration,
          method: (scenario.method ?? "GET") as "GET",
          body: scenario.body,
          headers: scenario.headers,
        };

  const result = await autocannon(options);
  const raw = result as unknown as Record<string, unknown>;
  const latency = result.latency as unknown as Record<string, number>;

  const sample: RunSample = {
    requestsPerSecond: Math.round(result.requests.average),
    latency: {
      p50: latency.p50 ?? 0,
      p90: latency.p90 ?? 0,
      p97_5: latency.p97_5 ?? 0,
      p99: latency.p99 ?? 0,
      avg: result.latency.average,
      max: result.latency.max,
    },
    status2xx: statusClass(raw, "2xx"),
    non2xx: typeof raw.non2xx === "number" ? raw.non2xx : 0,
    errors: result.errors,
    timeouts: result.timeouts,
    totalRequests: result.requests.total ?? 0,
  };

  // Gate: a benchmark whose responses are not what the scenario claims is
  // measuring garbage — fail loudly instead of reporting it.
  const problems: string[] = [];
  if (sample.errors > 0) problems.push(`${sample.errors} socket errors`);
  if (sample.timeouts > 0) problems.push(`${sample.timeouts} timeouts`);
  if (scenario.expectStatus === 200 && sample.non2xx > 0) {
    problems.push(`${sample.non2xx} non-2xx responses (expected all 200)`);
  }
  if (scenario.expectStatus === 404 && sample.status2xx > 0) {
    problems.push(`${sample.status2xx} 2xx responses (expected all 404)`);
  }
  if (problems.length > 0) {
    throw new Error(`Scenario ${scenario.name}: ${problems.join(", ")}`);
  }

  return sample;
}

async function runThroughput(
  baseUrl: string,
  list: BenchScenario[],
): Promise<ThroughputResult[]> {
  const samplesByScenario = new Map<string, RunSample[]>();
  for (const s of list) samplesByScenario.set(s.name, []);

  for (let run = 1; run <= runs; run++) {
    console.log(`  Round ${run}/${runs}`);
    for (const scenario of list) {
      process.stdout.write(`    ${scenario.name} ...`);
      const sample = await runScenarioOnce(baseUrl, scenario, `r${run}`);
      samplesByScenario.get(scenario.name)!.push(sample);
      console.log(
        ` ${sample.requestsPerSecond} req/s (p50: ${sample.latency.p50}ms)`,
      );
    }
  }

  return list.map((scenario) => {
    const samples = samplesByScenario.get(scenario.name)!;
    const medLatency = (k: keyof RunSample["latency"]) =>
      median(samples.map((s) => s.latency[k]));
    return {
      scenario: scenario.name,
      description: scenario.description,
      kind: scenario.kind,
      pathSample: scenario.path,
      uniquePaths:
        scenario.kind === "unique" ? resolvePaths(scenario, "count").length : 1,
      expectStatus: scenario.expectStatus,
      runs: samples,
      requestsPerSecond: aggregate(samples.map((s) => s.requestsPerSecond)),
      latency: {
        p50: medLatency("p50"),
        p90: medLatency("p90"),
        p97_5: medLatency("p97_5"),
        p99: medLatency("p99"),
        avg: medLatency("avg"),
        max: medLatency("max"),
      },
      duration,
      connections,
    };
  });
}

// -- Server Timing profiles --

const TIMING_SAMPLES = 5;

async function collectTimings(baseUrl: string): Promise<TimingResult[]> {
  const results: TimingResult[] = [];

  for (const p of timingPaths) {
    try {
      const samples: {
        totalMs: number;
        timings: Record<string, number>;
        bodyBytes: number;
      }[] = [];
      for (let i = 0; i < TIMING_SAMPLES; i++) {
        const res = await fetch(`${baseUrl}/timing${p}`);
        if (!res.ok) break;
        const data = (await res.json()) as {
          totalMs: number;
          bodyBytes?: number;
          timings: Record<string, number>;
        };
        samples.push({
          totalMs: data.totalMs,
          timings: data.timings,
          bodyBytes: data.bodyBytes ?? 0,
        });
      }
      if (samples.length === 0) continue;

      const keys = new Set<string>();
      for (const s of samples)
        for (const k of Object.keys(s.timings)) keys.add(k);
      const medTimings: Record<string, number> = {};
      for (const k of keys) {
        medTimings[k] = parseFloat(
          median(samples.map((s) => s.timings[k] ?? 0)).toFixed(2),
        );
      }
      results.push({
        path: p,
        samples: samples.length,
        totalMs: parseFloat(median(samples.map((s) => s.totalMs)).toFixed(2)),
        bodyBytes: Math.round(median(samples.map((s) => s.bodyBytes))),
        timings: medTimings,
      });
    } catch {
      // Timing endpoint may not be available
    }
  }

  return results;
}

// -- Main --

/**
 * Remote first-hit pass: one sequential timed request per cold-start path.
 * Only meaningful right after a deploy (fresh isolates); n=1 per path by
 * nature — an edge isolate stays warm once touched.
 */
async function runEdgeFirstHits(baseUrl: string): Promise<ColdStartResult[]> {
  const results: ColdStartResult[] = [];
  for (const c of coldStartPaths) {
    const r = await timedFetch(`${baseUrl}${c.path}`, {
      accept: c.path === "/" ? "text/html" : "*/*",
    });
    if (r.status !== 200) {
      throw new Error(
        `Edge first-hit ${c.path} returned ${r.status} (expected 200)`,
      );
    }
    const ms = parseFloat(r.ms.toFixed(2));
    results.push({
      path: c.path,
      description: `${c.description} (n=1, post-deploy)`,
      runsMs: [ms],
      medianMs: ms,
      minMs: ms,
      maxMs: ms,
    });
  }
  return results;
}

async function main() {
  let buildSizes: BuildSizes | undefined;

  // Build if production (remote deployments are already built)
  if (mode === "production") {
    console.log("Building...");
    const buildStart = Date.now();
    execSync(`${binPath(CWD, "vite")} build`, { cwd: CWD, stdio: "pipe" });
    buildSizes = collectBuildSizes(Date.now() - buildStart);
    console.log(`  Done in ${(buildSizes.buildTimeMs / 1000).toFixed(1)}s\n`);
  }

  // Cold-start phase: fresh server per run, no warmup beforehand
  let coldStart: ColdStartResult[] | undefined;
  if (mode === "production" && !args["skip-cold"] && coldRuns > 0) {
    console.log(`Cold start (${coldRuns} fresh server starts)...`);
    coldStart = await runColdPhase();
    console.log("");
  }

  // Target: a remote deployment, or a locally spawned server
  let server: Server | null = null;
  let baseUrl: string;
  if (remoteUrl) {
    baseUrl = remoteUrl;
    console.log(`Benching remote deployment: ${baseUrl}\n`);
    if (!args["skip-cold"]) {
      console.log("Edge first hits (meaningful right after a deploy)...");
      coldStart = await runEdgeFirstHits(baseUrl);
      console.log(`  Captured ${coldStart.length} first-hit timings\n`);
    }
  } else {
    console.log(`Starting ${mode} server...`);
    server =
      mode === "production"
        ? await startProdServer(CWD)
        : await startDevServer(CWD);
    baseUrl = `http://localhost:${server.port}`;
    console.log(`  Ready at ${baseUrl} (${server.command})\n`);
  }

  const meta = getMeta(server?.command ?? `remote ${baseUrl}`);
  console.log(
    `Benchmark: ${meta.commit}${meta.dirty ? " (dirty)" : ""} | ${meta.mode} | ${runs} runs x ${duration}s x ${connections} connections\n`,
  );

  if (args.baseline && meta.dirty) {
    await server?.kill();
    console.error(
      "Refusing --baseline from a dirty tree: baselines must be reproducible.",
    );
    process.exit(1);
  }

  try {
    const allScenarios = await prepareScenarios(baseUrl);

    // Validate every scenario returns what it claims before loading it
    console.log("Validating scenarios...");
    await validateScenarios(baseUrl, allScenarios);
    console.log("  All scenarios return expected responses\n");

    // RSS before warmup (local process group only)
    const rssBeforeWarmup = server ? getGroupRssKb(server.pid) : 0;

    // Warmup
    console.log("Warming up...");
    await warmup(baseUrl, allScenarios);
    const rssAfterWarmup = server ? getGroupRssKb(server.pid) : 0;
    if (server) {
      console.log(
        `  RSS: ${Math.round(rssBeforeWarmup / 1024)} MB -> ${Math.round(rssAfterWarmup / 1024)} MB after warmup\n`,
      );
    }

    // Throughput with RSS polling (RSS only when the server is local)
    let throughput: ThroughputResult[] = [];
    let rssResult = { peakRssKb: 0, finalRssKb: 0, peakWorkerdKb: 0 };
    if (!args["skip-throughput"]) {
      console.log("Running throughput scenarios...");
      const rssPoller = server ? startRssPolling(server.pid) : null;
      throughput = await runThroughput(baseUrl, allScenarios);
      if (rssPoller) {
        rssResult = rssPoller.stop();
        console.log(
          `  Peak RSS during load: ${Math.round(rssResult.peakRssKb / 1024)} MB (workerd: ${Math.round(rssResult.peakWorkerdKb / 1024)} MB)\n`,
        );
      }
    }

    // Server Timing
    console.log("Collecting server timing profiles...");
    const serverTiming = await collectTimings(baseUrl);
    console.log(`  Collected ${serverTiming.length} profiles\n`);

    const memory = server
      ? {
          beforeWarmupMb: Math.round(rssBeforeWarmup / 1024),
          afterWarmupMb: Math.round(rssAfterWarmup / 1024),
          peakUnderLoadMb: Math.round(rssResult.peakRssKb / 1024),
          finalMb: Math.round(rssResult.finalRssKb / 1024),
          workerdPeakMb: Math.round(rssResult.peakWorkerdKb / 1024),
        }
      : undefined;

    const result: BenchmarkResult = {
      meta,
      build: buildSizes,
      coldStart,
      throughput,
      serverTiming,
      memory,
    };

    // Output
    const md = formatMarkdown(result);
    console.log(md);

    // Write files
    const resultsDir = path.join(CWD, "bench", "results");
    mkdirSync(resultsDir, { recursive: true });
    const basename = `bench-${meta.date}-${meta.commit}${meta.dirty ? "-dirty" : ""}${remoteUrl ? "-edge" : ""}`;
    const jsonPath = path.join(resultsDir, `${basename}.json`);
    writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    writeFileSync(path.join(resultsDir, `${basename}.md`), md);
    console.log(`Results written to bench/results/${basename}.{json,md}`);

    if (args.baseline) {
      copyFileSync(jsonPath, path.join(resultsDir, "baseline.json"));
      console.log("Baseline updated: bench/results/baseline.json");
    }
  } finally {
    if (server) {
      console.log("\nStopping server...");
      await server.kill();
    }
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
