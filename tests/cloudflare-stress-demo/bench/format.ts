export interface ThroughputResult {
  scenario: string;
  description: string;
  path: string;
  requestsPerSecond: number;
  latency: {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
    max: number;
  };
  errors: number;
  timeouts: number;
  duration: number;
  connections: number;
}

export interface TimingResult {
  path: string;
  totalMs: number;
  timings: Record<string, number>;
}

export interface BuildSizes {
  client: { totalBytes: number; jsBytes: number; cssBytes: number };
  rsc: { totalBytes: number };
  ssr: { totalBytes: number };
  total: number;
  buildTimeMs: number;
}

export interface BenchmarkResult {
  meta: {
    date: string;
    commit: string;
    dirty: boolean;
    mode: string;
    nodeVersion: string;
    platform: string;
    cpu: string;
    cores: number;
    ramGb: number;
  };
  build?: BuildSizes;
  throughput: ThroughputResult[];
  serverTiming: TimingResult[];
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
  lines.push(`- CPU: ${meta.cpu} (${meta.cores} cores)`);
  lines.push(`- RAM: ${meta.ramGb} GB`);
  lines.push(`- OS: ${meta.platform}`);
  lines.push(`- Node: ${meta.nodeVersion}`);
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

  lines.push(
    `## Throughput (${result.throughput[0]?.duration ?? 10}s, ${result.throughput[0]?.connections ?? 10} connections)`,
  );
  lines.push("");
  lines.push("| Scenario | req/s | p50 ms | p95 ms | p99 ms | Errors |");
  lines.push("|----------|-------|--------|--------|--------|--------|");
  for (const t of result.throughput) {
    lines.push(
      `| ${pad(t.scenario, 20)} | ${rpad(fmtNum(t.requestsPerSecond), 5)} | ${rpad(fmtMs(t.latency.p50), 6)} | ${rpad(fmtMs(t.latency.p95), 6)} | ${rpad(fmtMs(t.latency.p99), 6)} | ${rpad(String(t.errors + t.timeouts), 6)} |`,
    );
  }
  lines.push("");

  if (result.serverTiming.length > 0) {
    // Show only the most informative timing keys
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
    // Use priority keys that exist, then any remaining
    const keys = keyPriority.filter((k) => allKeys.has(k));

    lines.push("## Server Timing (single request, no load)");
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

  return lines.join("\n");
}

export function formatCompare(
  before: BenchmarkResult,
  after: BenchmarkResult,
): string {
  const lines: string[] = [];
  lines.push(`# Comparison: ${before.meta.commit} -> ${after.meta.commit}`);
  lines.push("");
  lines.push("| Scenario | Before req/s | After req/s | Change |");
  lines.push("|----------|-------------|------------|--------|");

  const beforeMap = new Map(before.throughput.map((t) => [t.scenario, t]));

  for (const a of after.throughput) {
    const b = beforeMap.get(a.scenario);
    if (!b) {
      lines.push(
        `| ${a.scenario} | - | ${fmtNum(a.requestsPerSecond)} | new |`,
      );
      continue;
    }
    const delta =
      ((a.requestsPerSecond - b.requestsPerSecond) / b.requestsPerSecond) * 100;
    const sign = delta > 0 ? "+" : "";
    const noise = Math.abs(delta) < 5 ? " (noise)" : "";
    lines.push(
      `| ${a.scenario} | ${fmtNum(b.requestsPerSecond)} | ${fmtNum(a.requestsPerSecond)} | ${sign}${delta.toFixed(1)}%${noise} |`,
    );
  }

  return lines.join("\n");
}
