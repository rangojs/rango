// Post-build script: patches Vercel Build Output with ISR artifacts.
//
// Vercel ISR works by:
// 1. A route rule in config.json captures the original URL into __isr_route
// 2. A symlinked .func directory points to the same server function
// 3. A .prerender-config.json tells Vercel the caching policy
// 4. At runtime, the handler extracts the original URL and processes it normally
//
// The edge cache sits in front of the function — when fresh, the function
// is never invoked. When stale, it serves the stale response immediately
// and re-invokes the function in the background.
//
// IMPORTANT: RSC navigation requests (_rsc_partial) must bypass ISR. ISR caches
// the full HTTP response by URL — it can't distinguish between HTML (document)
// and RSC Flight payload responses. Caching RSC responses would break both
// document requests (get raw Flight) and navigations (get stale/wrong segments).

import { readFileSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ISR_TTL = 60; // seconds
const OUTPUT = resolve(".", ".vercel/output");
const FUNC_DIR = resolve(OUTPUT, "functions");

// 1. Patch config.json
const configPath = resolve(OUTPUT, "config.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));

// Remove the existing catch-all routes — we'll replace them with ISR-aware routes.
config.routes = config.routes.filter(
  (r) =>
    !(r.src === "/?(?<slug>.+)" && r.dest === "/[...slug]") &&
    !(r.src === "/(.*)" && r.dest === "/__server")
);

// Route 1: RSC navigation requests bypass ISR (go to plain server function).
// These have _rsc_partial query param and return Flight payloads, not HTML.
config.routes.push({
  src: "/(.*)",
  has: [{ type: "query", key: "_rsc_partial" }],
  dest: "/__server",
});

// Route 2: Document requests (Accept: text/html) go through ISR.
// Only HTML responses get cached — this prevents ISR from caching
// Flight payloads when bots/tools request without Accept header.
config.routes.push({
  src: "(?<__isr_route>/.*)",
  has: [{ type: "header", key: "accept", value: "text/html" }],
  dest: "/[...slug]-isr?__isr_route=$__isr_route",
});

// Route 3: Everything else (no Accept: text/html) goes to plain server.
config.routes.push({
  src: "/(.*)",
  dest: "/__server",
});

writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log("[isr] Patched config.json (RSC requests bypass ISR)");

// 2. Create symlinked .func directory
const isrFuncPath = resolve(FUNC_DIR, "[...slug]-isr.func");
if (!existsSync(isrFuncPath)) {
  symlinkSync("./__server.func", isrFuncPath, "junction");
  console.log("[isr] Created symlink: [...slug]-isr.func -> __server.func");
}

// 3. Write prerender-config.json
const prerenderConfig = {
  expiration: ISR_TTL,
  allowQuery: ["__isr_route"],
};
const prerenderPath = resolve(FUNC_DIR, "[...slug]-isr.prerender-config.json");
writeFileSync(prerenderPath, JSON.stringify(prerenderConfig, null, 2));
console.log(`[isr] Wrote prerender-config.json (TTL: ${ISR_TTL}s)`);

console.log("[isr] Done — deploy with: npx vercel deploy --prebuilt --prod");
