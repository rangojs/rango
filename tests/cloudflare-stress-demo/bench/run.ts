import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import autocannon from "autocannon";
import { scenarios, timingPaths, warmupPaths } from "./scenarios.js";
import { startDevServer, startProdServer } from "./server.js";
import {
  formatMarkdown,
  type BenchmarkResult,
  type BuildSizes,
  type ThroughputResult,
  type TimingResult,
} from "./format.js";

const CWD = path.resolve(import.meta.dirname, "..");

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "dev" },
    duration: { type: "string", default: "10" },
    connections: { type: "string", default: "10" },
    warmup: { type: "string", default: "50" },
  },
});

const mode = args.mode as "dev" | "production";
const duration = parseInt(args.duration!, 10);
const connections = parseInt(args.connections!, 10);
const warmupCount = parseInt(args.warmup!, 10);

// -- Metadata --

function getMeta() {
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
      const fullPath = path.join(entry.parentPath ?? entry.path, entry.name);
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

// -- Warmup --

async function warmup(baseUrl: string) {
  console.log(`  Triggering lazy includes...`);
  for (const p of warmupPaths) {
    await fetch(`${baseUrl}${p}`).catch(() => {});
  }

  console.log(`  Sending ${warmupCount} warmup requests...`);
  for (let i = 0; i < warmupCount; i++) {
    await fetch(`${baseUrl}/json-api/health`).catch(() => {});
  }
}

// -- Throughput --

async function runScenario(baseUrl: string): Promise<ThroughputResult[]> {
  const results: ThroughputResult[] = [];

  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.name} ...`);
    const result = await autocannon({
      url: `${baseUrl}${scenario.path}`,
      connections,
      duration,
      headers: scenario.headers as Record<string, string> | undefined,
    });

    const t: ThroughputResult = {
      scenario: scenario.name,
      description: scenario.description,
      path: scenario.path,
      requestsPerSecond: Math.round(result.requests.average),
      latency: {
        p50: result.latency.p50,
        p95: (result.latency as any).p97_5,
        p99: result.latency.p99,
        avg: result.latency.average,
        max: result.latency.max,
      },
      errors: result.errors,
      timeouts: result.timeouts,
      duration,
      connections,
    };
    results.push(t);
    console.log(` ${t.requestsPerSecond} req/s (p50: ${t.latency.p50}ms)`);
  }

  return results;
}

// -- Server Timing profiles --

async function collectTimings(baseUrl: string): Promise<TimingResult[]> {
  const results: TimingResult[] = [];

  for (const p of timingPaths) {
    try {
      const res = await fetch(`${baseUrl}/timing${p}`);
      if (res.ok) {
        const data = (await res.json()) as TimingResult;
        results.push(data);
      }
    } catch {
      // Timing endpoint may not be available in dev mode
    }
  }

  return results;
}

// -- Main --

async function main() {
  const meta = getMeta();
  console.log(
    `\nBenchmark: ${meta.commit}${meta.dirty ? " (dirty)" : ""} | ${meta.mode} mode | ${duration}s x ${connections} connections\n`,
  );

  let buildSizes: BuildSizes | undefined;

  // Build if production
  if (mode === "production") {
    console.log("Building...");
    const buildStart = Date.now();
    execSync("pnpm build", { cwd: CWD, stdio: "pipe" });
    buildSizes = collectBuildSizes(Date.now() - buildStart);
    console.log(`  Done in ${(buildSizes.buildTimeMs / 1000).toFixed(1)}s\n`);
  }

  // Start server
  console.log(`Starting ${mode} server...`);
  const server =
    mode === "production"
      ? await startProdServer(CWD)
      : await startDevServer(CWD);
  const baseUrl = `http://localhost:${server.port}`;
  console.log(`  Ready at ${baseUrl}\n`);

  try {
    // Warmup
    console.log("Warming up...");
    await warmup(baseUrl);
    console.log("");

    // Throughput
    console.log("Running throughput scenarios...");
    const throughput = await runScenario(baseUrl);
    console.log("");

    // Server Timing
    console.log("Collecting server timing profiles...");
    const serverTiming = await collectTimings(baseUrl);
    console.log(`  Collected ${serverTiming.length} profiles\n`);

    // Assemble result
    const result: BenchmarkResult = {
      meta,
      build: buildSizes,
      throughput,
      serverTiming,
    };

    // Output
    const md = formatMarkdown(result);
    console.log(md);

    // Write files
    const resultsDir = path.join(CWD, "bench", "results");
    mkdirSync(resultsDir, { recursive: true });
    const basename = `bench-${meta.date}-${meta.commit}`;
    writeFileSync(
      path.join(resultsDir, `${basename}.json`),
      JSON.stringify(result, null, 2),
    );
    writeFileSync(path.join(resultsDir, `${basename}.md`), md);
    console.log(`Results written to bench/results/${basename}.{json,md}`);
  } finally {
    console.log("\nStopping server...");
    await server.kill();
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
