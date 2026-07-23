/**
 * Result types and markdown formatting for the bench harness.
 *
 * Every throughput scenario is run `runs` times; tables report the median
 * across runs with the inter-quartile range (IQR) so a reader can tell a real
 * delta from run-to-run noise. Percentiles keep autocannon's real names —
 * autocannon reports p97_5, not p95; the old harness mislabeled it.
 */

export interface RunSample {
  requestsPerSecond: number;
  latency: {
    p50: number;
    p90: number;
    p97_5: number;
    p99: number;
    avg: number;
    max: number;
  };
  status2xx: number;
  non2xx: number;
  errors: number;
  timeouts: number;
  totalRequests: number;
}

export interface Aggregate {
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

export interface ThroughputResult {
  scenario: string;
  description: string;
  kind: "fixed" | "unique";
  pathSample: string;
  uniquePaths: number;
  expectStatus: number;
  runs: RunSample[];
  requestsPerSecond: Aggregate;
  /** Median across runs, per percentile. */
  latency: RunSample["latency"];
  duration: number;
  connections: number;
}

export interface TimingResult {
  path: string;
  samples: number;
  totalMs: number;
  bodyBytes: number;
  timings: Record<string, number>;
}

export interface ColdStartResult {
  path: string;
  description: string;
  /** TTFB+body ms, one entry per fresh server start. */
  runsMs: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export interface BuildSizes {
  client: { totalBytes: number; jsBytes: number; cssBytes: number };
  rsc: { totalBytes: number };
  ssr: { totalBytes: number };
  total: number;
  buildTimeMs: number;
}

export interface MemoryResult {
  beforeWarmupMb: number;
  afterWarmupMb: number;
  peakUnderLoadMb: number;
  finalMb: number;
  /** RSS of workerd processes only, if identifiable (0 = not found). */
  workerdPeakMb: number;
}

export interface BenchmarkResult {
  meta: {
    date: string;
    commit: string;
    dirty: boolean;
    mode: string;
    serverCommand: string;
    runs: number;
    duration: number;
    connections: number;
    nodeVersion: string;
    platform: string;
    cpu: string;
    cores: number;
    ramGb: number;
  };
  build?: BuildSizes;
  coldStart?: ColdStartResult[];
  throughput: ThroughputResult[];
  serverTiming: TimingResult[];
  memory?: MemoryResult;
}

export function aggregate(values: number[]): Aggregate {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return {
    median: at(0.5),
    p25: at(0.25),
    p75: at(0.75),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

export function median(values: number[]): number {
  return aggregate(values).median;
}

function pad(s: string, n: number) {
  return s.padEnd(n);
}
function rpad(s: string, n: number) {
  return s.padStart(n);
}
function fmtNum(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function fmtMs(n: number | undefined) {
  return n != null ? n.toFixed(1) : "-";
}
function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMarkdown(result: BenchmarkResult): string {
  const lines: string[] = [];
  const { meta } = result;

  lines.push(
    `# Benchmark - ${meta.commit}${meta.dirty ? " (dirty)" : ""} (${meta.date}, ${meta.mode})`,
  );
  lines.push("");
  lines.push(`- Server: \`${meta.serverCommand}\``);
  lines.push(
    `- Load: ${meta.runs} runs x ${meta.duration}s x ${meta.connections} connections per scenario`,
  );
  lines.push(`- CPU: ${meta.cpu} (${meta.cores} cores)`);
  lines.push(`- RAM: ${meta.ramGb} GB`);
  lines.push(`- OS: ${meta.platform}`);
  lines.push(`- Node: ${meta.nodeVersion}`);
  lines.push("");
  if (meta.mode === "edge") {
    lines.push(
      "Caveat: remote-edge numbers include network RTT from the bench host;",
    );
    lines.push(
      "latency is RTT-dominated — compare scenarios against each other, and",
    );
    lines.push("read first-hit rows as n=1 (isolates stay warm once touched).");
  } else {
    lines.push(
      "Caveat: local single-host numbers (load generator shares the machine).",
    );
    lines.push(
      "Comparative use only; absolute numbers require a deployed-edge run.",
    );
  }
  lines.push("");

  if (result.build) {
    const b = result.build;
    lines.push("## Build");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Build time | ${(b.buildTimeMs / 1000).toFixed(1)}s |`);
    lines.push(`| Client JS | ${fmtBytes(b.client.jsBytes)} |`);
    lines.push(`| Client CSS | ${fmtBytes(b.client.cssBytes)} |`);
    lines.push(`| RSC | ${fmtBytes(b.rsc.totalBytes)} |`);
    lines.push(`| SSR | ${fmtBytes(b.ssr.totalBytes)} |`);
    lines.push(`| Total | ${fmtBytes(b.total)} |`);
    lines.push("");
  }

  if (result.coldStart && result.coldStart.length > 0) {
    const n = result.coldStart[0]!.runsMs.length;
    lines.push(`## Cold start (first requests after ${n} fresh server starts)`);
    lines.push("");
    lines.push("| Path | What it pays | median ms | min | max |");
    lines.push("|------|--------------|-----------|-----|-----|");
    for (const c of result.coldStart) {
      lines.push(
        `| ${c.path} | ${c.description} | ${fmtMs(c.medianMs)} | ${fmtMs(c.minMs)} | ${fmtMs(c.maxMs)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Throughput (median across runs, IQR in parentheses)");
  lines.push("");
  lines.push(
    "| Scenario | Kind | req/s | IQR | p50 ms | p90 ms | p97.5 ms | p99 ms |",
  );
  lines.push(
    "|----------|------|-------|-----|--------|--------|----------|--------|",
  );
  for (const t of result.throughput) {
    const r = t.requestsPerSecond;
    lines.push(
      `| ${pad(t.scenario, 22)} | ${t.kind} | ${rpad(fmtNum(r.median), 6)} | ${fmtNum(r.p25)}-${fmtNum(r.p75)} | ${rpad(fmtMs(t.latency.p50), 5)} | ${rpad(fmtMs(t.latency.p90), 5)} | ${rpad(fmtMs(t.latency.p97_5), 5)} | ${rpad(fmtMs(t.latency.p99), 5)} |`,
    );
  }
  lines.push("");
  lines.push(
    "`fixed` scenarios hammer one URL and measure the pipeline floor (the",
  );
  lines.push(
    "router's pathname cache absorbs matching); `unique` scenarios cycle",
  );
  lines.push("distinct paths so every request performs real matching.");
  lines.push("");

  if (result.serverTiming.length > 0) {
    const keyPriority = [
      "route-matching",
      "handler-total",
      "handler-mw-match",
      "pipeline-segment-resolve",
      "pipeline-cache-lookup",
      "pipeline-cache-store",
      "render-total",
      "rsc-serialize",
      "ssr-render-html",
      "ssr-module-load",
    ];
    const allKeys = new Set<string>();
    for (const st of result.serverTiming) {
      for (const k of Object.keys(st.timings)) allKeys.add(k);
    }
    const keys = keyPriority.filter((k) => allKeys.has(k));

    lines.push(
      `## Server Timing (median of ${result.serverTiming[0]?.samples ?? 1} single requests, no load)`,
    );
    lines.push("");
    const header = `| Path | Total | ${keys.join(" | ")} |`;
    const sep = `|------|-------|${keys.map(() => "-------").join("|")}|`;
    lines.push(header);
    lines.push(sep);
    for (const st of result.serverTiming) {
      const vals = keys.map((k) =>
        st.timings[k] !== undefined ? `${fmtMs(st.timings[k])}ms` : "-",
      );
      lines.push(
        `| ${st.path} | ${fmtMs(st.totalMs)}ms | ${vals.join(" | ")} |`,
      );
    }
    lines.push("");
  }

  if (result.memory) {
    const m = result.memory;
    lines.push("## Memory (toolchain process-group RSS, not isolate heap)");
    lines.push("");
    lines.push("| Phase | RSS |");
    lines.push("|-------|-----|");
    lines.push(`| Before warmup | ${m.beforeWarmupMb} MB |`);
    lines.push(`| After warmup | ${m.afterWarmupMb} MB |`);
    lines.push(`| Peak under load | ${m.peakUnderLoadMb} MB |`);
    lines.push(`| Final (after load) | ${m.finalMb} MB |`);
    if (m.workerdPeakMb > 0) {
      lines.push(`| workerd only, peak | ${m.workerdPeakMb} MB |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Compare two results. A delta counts as significant only when it clears the
 * combined run-to-run variance of both sides (IQR-based), with a 3% floor —
 * n-run local benches cannot resolve differences below that.
 */
export function formatCompare(
  before: BenchmarkResult,
  after: BenchmarkResult,
): string {
  const lines: string[] = [];
  lines.push(`# Comparison: ${before.meta.commit} -> ${after.meta.commit}`);
  lines.push("");
  if (before.meta.dirty || after.meta.dirty) {
    lines.push("WARNING: at least one side was benched from a dirty tree.");
    lines.push("");
  }
  lines.push("| Scenario | Before req/s | After req/s | Change | Verdict |");
  lines.push("|----------|-------------|------------|--------|---------|");

  const beforeMap = new Map(before.throughput.map((t) => [t.scenario, t]));

  for (const a of after.throughput) {
    const b = beforeMap.get(a.scenario);
    if (!b) {
      lines.push(
        `| ${a.scenario} | - | ${fmtNum(a.requestsPerSecond.median)} | new | - |`,
      );
      continue;
    }
    const bm = b.requestsPerSecond;
    const am = a.requestsPerSecond;
    const delta = ((am.median - bm.median) / bm.median) * 100;
    const bIqrPct = ((bm.p75 - bm.p25) / bm.median) * 100;
    const aIqrPct = ((am.p75 - am.p25) / am.median) * 100;
    const threshold = Math.max(3, (bIqrPct + aIqrPct) / 2);
    const verdict =
      Math.abs(delta) >= threshold
        ? "significant"
        : `within variance (±${threshold.toFixed(1)}%)`;
    const sign = delta > 0 ? "+" : "";
    lines.push(
      `| ${a.scenario} | ${fmtNum(bm.median)} | ${fmtNum(am.median)} | ${sign}${delta.toFixed(1)}% | ${verdict} |`,
    );
  }

  if (before.coldStart && after.coldStart) {
    lines.push("");
    lines.push("| Cold start path | Before ms | After ms | Change |");
    lines.push("|-----------------|-----------|----------|--------|");
    const beforeCold = new Map(before.coldStart.map((c) => [c.path, c]));
    for (const a of after.coldStart) {
      const b = beforeCold.get(a.path);
      if (!b) continue;
      const delta = ((a.medianMs - b.medianMs) / b.medianMs) * 100;
      const sign = delta > 0 ? "+" : "";
      lines.push(
        `| ${a.path} | ${fmtMs(b.medianMs)} | ${fmtMs(a.medianMs)} | ${sign}${delta.toFixed(1)}% |`,
      );
    }
  }

  return lines.join("\n");
}
