/**
 * Cold-start-only runner for A/B spikes (issue #665 text-module manifest).
 * Replicates run.ts runColdPhase exactly: fresh `wrangler dev` per run,
 * TCP-only readiness, sequential first hits of coldStartPaths. Prints a
 * per-path median table. Usage: npx tsx bench/cold-only.ts [runs]
 */
import { startProdServer } from "./server.js";
import { coldStartPaths } from "./scenarios.js";

const CWD = new URL("..", import.meta.url).pathname;
const runs = parseInt(process.argv[2] ?? "5", 10);

async function timedFetch(url: string, accept: string) {
  const start = performance.now();
  const res = await fetch(url, { headers: { accept } });
  await res.text();
  return { status: res.status, ms: performance.now() - start };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const byPath = new Map<string, number[]>();
for (const c of coldStartPaths) byPath.set(c.path, []);

for (let i = 0; i < runs; i++) {
  process.stdout.write(`cold run ${i + 1}/${runs} ...`);
  const server = await startProdServer(CWD, { cold: true });
  try {
    for (const c of coldStartPaths) {
      const r = await timedFetch(
        `http://localhost:${server.port}${c.path}`,
        c.path === "/" ? "text/html" : "*/*",
      );
      if (r.status !== 200) throw new Error(`${c.path} returned ${r.status}`);
      byPath.get(c.path)!.push(r.ms);
    }
    console.log(" ok");
  } finally {
    await server.kill();
  }
}

console.log("\npath | median ms | min | max | runs");
for (const c of coldStartPaths) {
  const xs = byPath.get(c.path)!;
  console.log(
    `${c.path} | ${median(xs).toFixed(1)} | ${Math.min(...xs).toFixed(1)} | ${Math.max(...xs).toFixed(1)} | [${xs.map((v) => v.toFixed(0)).join(", ")}]`,
  );
}
