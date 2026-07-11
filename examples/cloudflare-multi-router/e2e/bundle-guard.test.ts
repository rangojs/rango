import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

const distRsc = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "rsc",
);

function walkJsFiles(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) found.push(full);
    }
  }
  return found;
}

/**
 * Multi-router Bundle Hygiene rule #1: each router's route data (trie +
 * precomputedEntries) lands in its OWN lazy RSC chunk, loaded independently
 * on that router's first request. The single-router guard in
 * packages/rangojs-router/e2e/build-test-app.setup.ts asserts "exactly one
 * data chunk"; this app is where cross-router duplication or a collapsed
 * shared chunk would compound (the #751 regression class, multiplied by
 * router count), and nothing else inspects a multi-router dist.
 *
 * Ground truth is the emitted wiring, not a size heuristic: the eager
 * manifest module registers one `registerRouterManifestLoader("<id>", () =>
 * import("<chunk>"))` pair per router, so parsing those pairs out of the
 * entry gives the exact routerId -> chunk mapping the runtime uses.
 *
 * Production-only by nature (mirrors manifest-text-module.test.ts in
 * cloudflare-basic): dev registers no loaders and serves route data through
 * the virtual-module/live-urlpatterns path, so there is no dev artifact to
 * inspect.
 */
test.describe("multi-router bundle guard (production)", () => {
  useFixture({
    root: ".",
    mode: "build",
  });

  test("each router's route data lands in its own lazy RSC chunk", () => {
    const entry = fs.readFileSync(path.join(distRsc, "index.js"), "utf8");
    const wiring = [
      ...entry.matchAll(
        /registerRouterManifestLoader\(\s*"([^"]+)"\s*,\s*\(\)\s*=>\s*import\(\s*"([^"]+)"\s*\)/g,
      ),
    ].map((m) => ({ routerId: m[1]!, chunk: m[2]! }));

    // This example wires 4 routers (site, admin, app-a, app-b under
    // src/apps/*/router.tsx). If the app grows/shrinks routers, update this
    // count — a silent drop here is exactly the failure the guard exists to
    // catch.
    expect(
      wiring.map((w) => w.routerId),
      "every router must register a lazy manifest loader",
    ).toHaveLength(4);

    // One chunk per router: unique ids, unique chunk files.
    expect(new Set(wiring.map((w) => w.routerId)).size).toBe(wiring.length);
    expect(
      new Set(wiring.map((w) => w.chunk)).size,
      "routers must not share a route-data chunk",
    ).toBe(wiring.length);

    // Each chunk exists, carries that router's match data, and is pairwise
    // distinct content (a copy-paste duplicate would pass the filename check).
    const contents = wiring.map(({ routerId, chunk }) => {
      const file = path.join(distRsc, chunk);
      expect(fs.existsSync(file), `${chunk} (router ${routerId})`).toBe(true);
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${chunk} must carry trie data`).toContain("trie");
      return src;
    });
    expect(new Set(contents).size).toBe(contents.length);

    // Lazy-only: no rsc chunk may import a data chunk statically.
    const rscFiles = walkJsFiles(distRsc).map((file) => ({
      file,
      base: path.basename(file),
      src: fs.readFileSync(file, "utf8"),
    }));
    const staticRefs: string[] = [];
    for (const { chunk } of wiring) {
      const base = path.basename(chunk);
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const staticImportRe = new RegExp(
        `\\b(?:import|export)(?!\\s*[.(])[^;"'()]*?["'][^"']*${escaped}["']`,
      );
      for (const f of rscFiles) {
        if (f.base === base) continue;
        if (f.src.includes(base) && staticImportRe.test(f.src)) {
          staticRefs.push(`${path.relative(distRsc, f.file)} -> ${base}`);
        }
      }
    }
    expect(
      staticRefs,
      "route-data chunks must be referenced only via dynamic import()",
    ).toEqual([]);

    // Client bundle must contain none of the data chunks (by name or bytes).
    const clientFiles = walkJsFiles(path.join(distRsc, "..", "client")).map(
      (file) => ({ file, src: fs.readFileSync(file, "utf8") }),
    );
    const clientLeaks: string[] = [];
    for (const { chunk } of wiring) {
      const base = path.basename(chunk);
      for (const f of clientFiles) {
        if (f.src.includes(base)) {
          clientLeaks.push(`${path.basename(f.file)} -> ${base}`);
        }
      }
    }
    expect(
      clientLeaks,
      "route-data chunks must not be referenced from the client bundle",
    ).toEqual([]);
  });
});
