import { readFileSync } from "node:fs";
import { formatCompare, type BenchmarkResult } from "./format.js";

const [, , beforePath, afterPath] = process.argv;

if (!beforePath || !afterPath) {
  console.error("Usage: npx tsx bench/compare.ts <before.json> <after.json>");
  process.exit(1);
}

const before: BenchmarkResult = JSON.parse(readFileSync(beforePath, "utf-8"));
const after: BenchmarkResult = JSON.parse(readFileSync(afterPath, "utf-8"));

console.log(formatCompare(before, after));
