// Local smoke test for the assembled .vercel/output, without deploying.
//
// Runs from an OS temp dir OUTSIDE the monorepo so it genuinely replicates
// Vercel's isolated function filesystem (`/var/task`). Serving in place would
// be a false positive: the app's own package.json (`"type": "module"`) and
// node_modules up the tree would mask both a missing func `type: module` and any
// externalized (un-bundled) dependency — the two failures a real deploy hits.
//
// It imports the bundled function (which throws if the bundle is not
// self-contained or not ESM), serves it behind Vercel's filesystem-then-function
// routing, and asserts the pages render and a static asset loads. The Runtime
// Cache store is Vercel-only; locally the app falls back to the in-memory store,
// so the cache observation is informational.
import os from "node:os";
import { rm, cp, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVercelOutputServer } from "./serve-vercel-output.mjs";

const appRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const builtOutput = path.join(appRoot, ".vercel", "output");

let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
};

// Request the full HTML document (a bare fetch sends Accept: */* and gets the
// RSC stream instead, which is the browser navigation/prefetch contract).
const htmlHeaders = { accept: "text/html" };

// Copy the build output to an isolated temp dir (no parent package.json /
// node_modules) so resolution matches the deployed function. mkdtemp gives a
// unique dir per run so concurrent smokes never clobber each other.
const isolated = await mkdtemp(path.join(os.tmpdir(), "rango-vercel-smoke-"));
let server;
// Everything after mkdtemp runs inside this try so the finally removes the
// unique temp dir even when the copy, function import, or server startup fails
// (a fixed-name dir self-heals by reuse; unique dirs would accumulate).
try {
  await cp(builtOutput, isolated, { recursive: true });

  server = await createVercelOutputServer(isolated);

  const port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
  const base = `http://localhost:${port}`;

  console.log(`(serving isolated build output from ${isolated})`);
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
      await (await fetch(`${base}/cached`, { headers: htmlHeaders })).text()
    ).match(/datetime="([^"]+)"/i)?.[1];
  const t1 = await readStamp();
  const t2 = await readStamp();
  check("GET /cached -> renders a timestamp", Boolean(t1));
  console.log(
    `INFO  /cached timestamps: ${t1} / ${t2} ${
      t1 && t1 === t2 ? "(cache hit)" : "(distinct; off-platform write timing)"
    }`,
  );
} finally {
  server?.close();
  await rm(isolated, { recursive: true, force: true });
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
process.exit(failed ? 1 : 0);
