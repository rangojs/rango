// Local smoke test for the assembled .vercel/output of a multi-app HOST router,
// without deploying. Mirrors examples/vercel-basic/scripts/smoke.mjs but routes by
// host: it imports the single bundled function (the isolated host entry serving
// hostRouter.match()) and drives it with explicit Host headers, asserting each
// sub-app renders and an unmatched host returns 404 (the generated entry catches
// NoRouteMatchError).
import http from "node:http";
import os from "node:os";
import { readFile, stat, rm, cp, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const builtOutput = path.join(appRoot, ".vercel", "output");

const CONTENT_TYPE = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
};

// Copy to an isolated temp dir (no parent package.json / node_modules) so module
// resolution matches the deployed function (catches an un-bundled dependency).
// mkdtemp gives a unique dir per run so concurrent smokes never clobber.
const isolated = await mkdtemp(
  path.join(os.tmpdir(), "rango-vercel-multi-smoke-"),
);
let server;
// Everything after mkdtemp runs inside this try so the finally removes the
// unique temp dir even when the copy, function import, or server startup fails
// (the old fixed-name dir self-healed by reuse; unique dirs would accumulate).
try {
  await cp(builtOutput, isolated, { recursive: true });

  const funcEntry = path.join(isolated, "functions", "index.func", "index.mjs");
  const staticDir = path.join(isolated, "static");

  const handler = (await import(pathToFileURL(funcEntry).href)).default;

  server = http.createServer(async (req, res) => {
    // Guard both decodeURIComponent (URIError on a malformed escape like `/%`) and
    // the awaited handler so a stray request returns a clean 4xx/5xx instead of an
    // unhandledRejection that kills the server (parity with vercel-basic's
    // serve-vercel-output.mjs).
    try {
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
                CONTENT_TYPE[path.extname(filePath)] ??
                  "application/octet-stream",
              );
              res.end(await readFile(filePath));
              return;
            }
          } catch {
            // fall through to the function
          }
        }
      }
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = err instanceof URIError ? 400 : 500;
        res.end();
      } else {
        // Headers already sent: end() would silently deliver a truncated body
        // as success and the in-flight assertion fetch would hang until the CI
        // timeout. Destroy the socket so the client fails fast with a stack.
        console.error("handler failed mid-stream:", err);
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });

  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

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
          res.on("error", reject);
        },
      );
      r.on("error", reject);
      r.end();
    });

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
  server?.close();
  await rm(isolated, { recursive: true, force: true });
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
process.exit(failed ? 1 : 0);
