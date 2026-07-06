// Shared launcher for the assembled .vercel/output. Imports the bundled
// function entry and returns an http.Server that serves Vercel's
// filesystem-then-function routing: an existing file under static/ is served
// directly; everything else is delegated to the function handler. Does not call
// listen() — the caller picks the port. Used by both scripts/preview.mjs (the
// Playwright production fixture / manual preview) and scripts/smoke.mjs (the
// isolated deploy smoke test).
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONTENT_TYPE = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

export async function createVercelOutputServer(outputDir) {
  const funcEntry = path.join(
    outputDir,
    "functions",
    "index.func",
    "index.mjs",
  );
  const staticDir = path.join(outputDir, "static");
  const handler = (await import(pathToFileURL(funcEntry).href)).default;

  return http.createServer(async (req, res) => {
    try {
      // decodeURIComponent throws URIError on a malformed escape (e.g. `/%`);
      // the awaited handler may reject. Guard both so a stray request returns a
      // clean 4xx/5xx instead of an unhandledRejection that kills the server.
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
        // as success and an in-flight client request would hang. Destroy the
        // socket so the client fails fast with a visible error.
        console.error("handler failed mid-stream:", err);
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
}
