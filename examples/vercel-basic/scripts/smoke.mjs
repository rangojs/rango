// Local smoke test for the assembled .vercel/output, without deploying.
//
// Imports the bundled function (which throws if the bundle is not self-contained),
// serves it over node:http alongside the static assets exactly as Vercel's
// filesystem-then-function routing would, and asserts the pages render and a
// static asset loads. The Runtime Cache store is Vercel-only; locally the app
// falls back to the in-memory store, so the cache observation is informational.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const out = path.join(appRoot, ".vercel", "output");
const funcEntry = path.join(out, "functions", "index.func", "index.mjs");
const staticDir = path.join(out, "static");

const CONTENT_TYPE = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".json": "application/json",
  ".ico": "image/x-icon",
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
  server.listen(0, () => resolve(server.address().port));
});
const base = `http://localhost:${port}`;

let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
};

// Request the full HTML document (a bare fetch sends Accept: */* and gets the
// RSC stream instead, which is the browser navigation/prefetch contract).
const htmlHeaders = { accept: "text/html" };

try {
  const home = await fetch(`${base}/`, { headers: htmlHeaders });
  const homeHtml = await home.text();
  check("GET / -> 200", home.status === 200);
  check("GET / streams an HTML document", /<html/i.test(homeHtml));
  check("GET / renders HomePage", homeHtml.includes("Rango on Vercel"));

  const about = await fetch(`${base}/about`, { headers: htmlHeaders });
  const aboutHtml = await about.text();
  check("GET /about -> 200", about.status === 200);
  check("GET /about renders AboutPage", aboutHtml.includes("About"));

  const assetMatch = homeHtml.match(/\/assets\/[A-Za-z0-9._-]+\.js/);
  if (assetMatch) {
    const asset = await fetch(`${base}${assetMatch[0]}`);
    check(`GET ${assetMatch[0]} (static asset) -> 200`, asset.status === 200);
  } else {
    check("home document references a static /assets/*.js", false);
  }

  // The <time> element serializes to a lowercase `datetime` attribute in HTML.
  const readStamp = async () =>
    (
      await (
        await fetch(`${base}/cached`, { headers: htmlHeaders }).then((r) =>
          r.text(),
        )
      ).match(/datetime="([^"]+)"/i)
    )?.[1];
  const t1 = await readStamp();
  const t2 = await readStamp();
  check("GET /cached -> renders a timestamp", Boolean(t1));
  console.log(
    `INFO  /cached timestamps: ${t1} / ${t2} ${
      t1 && t1 === t2 ? "(cache hit)" : "(distinct; off-platform write timing)"
    }`,
  );
} finally {
  server.close();
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
process.exit(failed ? 1 : 0);
