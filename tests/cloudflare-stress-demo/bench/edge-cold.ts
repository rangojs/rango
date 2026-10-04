/**
 * Edge first-hit pass against a deployed URL (issue #665 A/B spike).
 * Mirrors run.ts runEdgeFirstHits: one sequential timed request per
 * cold-start path, meaningful only right after a deploy (fresh isolates).
 * Usage: npx tsx bench/edge-cold.ts <label> [baseUrl]
 */
import { coldStartPaths } from "./scenarios.js";

const label = process.argv[2] ?? "run";
const baseUrl = (
  process.argv[3] ?? "https://cloudflare-stress-demo.example.workers.dev"
).replace(/\/$/, "");

console.log(`# ${label} — ${baseUrl}`);
for (const c of coldStartPaths) {
  const start = performance.now();
  const res = await fetch(`${baseUrl}${c.path}`, {
    headers: { accept: c.path === "/" ? "text/html" : "*/*" },
  });
  await res.text();
  const ms = performance.now() - start;
  if (res.status !== 200) {
    console.log(`${c.path} | STATUS ${res.status}`);
    process.exit(1);
  }
  console.log(`${c.path} | ${ms.toFixed(1)} ms | ${c.description}`);
}
