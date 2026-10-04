/**
 * Cache retention across a deploy: does a `cache()` entry written by one
 * build survive a server restart, a rebuild of unchanged source, and a
 * rebuild after a server-code change?
 *
 * This is a correctness check, not a timing: `/app/cached/hot` sits inside
 * `cache({ ttl: 300 })` on a CFCacheStore and renders `Date.now()` inside the
 * boundary, so the same number on a later request means the store served the
 * entry an earlier request wrote. With per-router cache versions
 * (docs/design/per-app-cache-version.md) the expected column is:
 *
 *   same server, restart, unchanged rebuild -> hit
 *   server code of this router changed      -> miss
 *
 * Usage: npx tsx bench/retention.ts
 * Exits non-zero when a row does not match its expectation. Leaves the source
 * tree as it found it (the edit is reverted and the app rebuilt).
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { binPath, startProdServer, type Server } from "./server.js";

const CWD = path.resolve(import.meta.dirname, "..");
const CACHED_PATH = "/app/cached/hot";
const EDITED_FILE = path.join(CWD, "src/pages/app-pages.tsx");
const EDIT_FROM = "<h1>Cached bucket ";
const EDIT_TO = "<h1>Cached bucket (retention check) ";

// Without a stable key every build makes its own, and a router that encrypts
// server-action arguments gets a new version on every build: the check would
// measure the key, not the feature.
const env = {
  ...process.env,
  RANGO_ENCRYPTION_KEY:
    process.env.RANGO_ENCRYPTION_KEY ??
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

interface Row {
  step: string;
  versions: string;
  renderedAt: string;
  result: "stored" | "hit" | "miss";
  expected: "stored" | "hit" | "miss";
}

/** `vite build`; returns the router's `data / document` versions. */
function build(): string {
  const output = execSync(`${binPath(CWD, "vite")} build`, {
    cwd: CWD,
    env,
    stdio: "pipe",
  }).toString();
  const match = output.match(/([0-9a-f]{16}) \/ ([0-9a-f]{16})\s+src\/router/);
  if (!match) {
    throw new Error(`no cache versions in the build output:\n${output}`);
  }
  return `${match[1]} / ${match[2]}`;
}

async function renderedAt(server: Server): Promise<string> {
  const res = await fetch(`http://localhost:${server.port}${CACHED_PATH}`, {
    headers: { accept: "text/html" },
  });
  const html = await res.text();
  const match = html.match(/cached-rendered-at">(?:<!-- -->)?(\d+)/);
  if (res.status !== 200 || !match) {
    throw new Error(`${CACHED_PATH} returned ${res.status} without a stamp`);
  }
  return match[1]!;
}

/** A port the OS just handed out, to reuse for every server of the run. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// The entry's key carries the request host: every server has to answer on the
// same port for a later one to find what an earlier one stored.
const port = await freePort();

async function withServer<T>(fn: (server: Server) => Promise<T>): Promise<T> {
  const server = await startProdServer(CWD, { port });
  try {
    return await fn(server);
  } finally {
    await server.kill();
  }
}

const rows: Row[] = [];
const original = readFileSync(EDITED_FILE, "utf-8");
if (!original.includes(EDIT_FROM)) {
  throw new Error(
    `${EDITED_FILE} no longer contains ${JSON.stringify(EDIT_FROM)}`,
  );
}

try {
  console.log("build 1 ...");
  const v1 = build();
  let stored = "";
  await withServer(async (server) => {
    stored = await renderedAt(server);
    rows.push({
      step: "First request",
      versions: v1,
      renderedAt: stored,
      result: "stored",
      expected: "stored",
    });
    const second = await renderedAt(server);
    rows.push({
      step: "Second request, same server",
      versions: v1,
      renderedAt: second,
      result: second === stored ? "hit" : "miss",
      expected: "hit",
    });
  });

  await withServer(async (server) => {
    const after = await renderedAt(server);
    rows.push({
      step: "Server restarted, same build",
      versions: v1,
      renderedAt: after,
      result: after === stored ? "hit" : "miss",
      expected: "hit",
    });
  });

  console.log("build 2 (no source change) ...");
  const v2 = build();
  await withServer(async (server) => {
    const after = await renderedAt(server);
    rows.push({
      step: "Rebuilt with no source change, first request",
      versions: v2,
      renderedAt: after,
      result: after === stored ? "hit" : "miss",
      expected: "hit",
    });
  });

  console.log("build 3 (server code of this router changed) ...");
  writeFileSync(EDITED_FILE, original.replace(EDIT_FROM, EDIT_TO));
  const v3 = build();
  await withServer(async (server) => {
    const after = await renderedAt(server);
    rows.push({
      step: "Rebuilt after a server-code change, first request",
      versions: v3,
      renderedAt: after,
      result: after === stored ? "hit" : "miss",
      expected: "miss",
    });
  });
} finally {
  if (readFileSync(EDITED_FILE, "utf-8") !== original) {
    writeFileSync(EDITED_FILE, original);
    console.log("restoring the source and rebuilding ...");
    build();
  }
}

console.log(
  "\n| Step | Versions (data / document) | Rendered-at | Result | Expected |",
);
console.log("| --- | --- | --- | --- | --- |");
for (const row of rows) {
  console.log(
    `| ${row.step} | \`${row.versions}\` | \`${row.renderedAt}\` | ${row.result} | ${row.expected} |`,
  );
}

const failed = rows.filter((row) => row.result !== row.expected);
if (failed.length > 0) {
  console.error(
    `\n${failed.length} row(s) did not match: ${failed.map((row) => row.step).join("; ")}`,
  );
  process.exit(1);
}
console.log("\nAll rows match.");
