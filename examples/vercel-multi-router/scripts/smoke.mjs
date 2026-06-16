// Local smoke test for the assembled .vercel/output of a multi-app HOST router,
// without deploying. Mirrors examples/vercel-basic/scripts/smoke.mjs but routes by
// host: it imports the single bundled function (the isolated host entry serving
// hostRouter.match()) and drives it with explicit Host headers, asserting each
// sub-app renders and an unmatched host returns 404 (the generated entry catches
// NoRouteMatchError).
import http from "node:http";
import os from "node:os";
import { readFile, stat, rm, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const builtOutput = path.join(appRoot, ".vercel", "output");

// Copy to an isolated temp dir (no parent package.json / node_modules) so module
// resolution matches the deployed function (catches an un-bundled dependency).
const isolated = path.join(os.tmpdir(), "rango-vercel-multi-smoke");
await rm(isolated, { recursive: true, force: true });
await cp(builtOutput, isolated, { recursive: true });

const funcEntry = path.join(isolated, "functions", "index.func", "index.mjs");
const staticDir = path.join(isolated, "static");

const CONTENT_TYPE = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

const handler = (await import(pathToFileURL(funcEntry).href)).default;

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(
    new URL(req.url, "http://localhost").pathname,
  );
  if (pathname !== "/") {
    const filePath = path.join(staticDir, pathname);
    if (filePath.startsWith(staticDir)) {
      try {
        const info = await stat(filePath);
        if (info.isFile()) {
          res.setHeader(
            "content-type",
            CONTENT_TYPE[path.extname(filePath)] ?? "application/octet-stream",
          );
          res.end(await readFile(filePath));
          return;
        }
      } catch {
        // fall through to the function
      }
    }
  }
  handler(req, res);
});

const port = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
};

// Drive the function with an explicit Host header (connect to loopback, override
// Host) so the host router sees the target hostname -- the deployed-domain shape.
const get = (host, pathname = "/") =>
  new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        headers: { host, accept: "text/html" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    r.on("error", reject);
    r.end();
  });

try {
  console.log(`(serving isolated build output from ${isolated})`);

  const a = await get("a.localhost");
  check("a.localhost -> 200", a.status === 200);
  check("a.localhost renders App A", a.body.includes("App A home"));

  const b = await get("b.localhost");
  check("b.localhost -> 200", b.status === 200);
  check("b.localhost renders App B", b.body.includes("App B home"));

  const unmatched = await get("c.localhost");
  check(
    "unmatched c.localhost -> 404 (generated entry catches NoRouteMatchError)",
    unmatched.status === 404,
  );
} finally {
  server.close();
  await rm(isolated, { recursive: true, force: true });
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
process.exit(failed ? 1 : 0);
