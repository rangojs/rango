import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

const distAssets = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "rsc",
  "assets",
);

function walkFiles(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  return found;
}

/**
 * Cloudflare builds ship the route trie / precomputedEntries as a workerd
 * Text module (assets/manifest-<routerId>-*.txt) instead of a JSON.parse
 * string literal inside the lazy manifest chunk (issue #665). This suite
 * pins that the build actually emits and wires the text module — a silent
 * fallback to the inline literal would pass every functional test while
 * losing the cold-start win.
 *
 * The Text module is cloudflare-only (workerd has no filesystem, so it is the
 * only way to get bytes into an isolate without JS compilation; node/vercel
 * keep the inline literal). This app's manifest is below the 512KB threshold
 * that triggers the channel automatically, so the production webServer forces
 * it with RANGO_MANIFEST_TEXT=1 (see playwright.config.ts) — the whole
 * production suite then runs on the Text channel, and this test asserts the
 * artifact.
 *
 * Production-only by nature: dev serves the manifest through the virtual
 * module with the inline literal (the whole dev suite covers that path).
 */
test.describe("manifest text module (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("routes match through the text-module manifest", async ({ request }) => {
    // Any successful match proves the worker loaded trie data from the text
    // module: production tries are authoritative, so a missing/broken text
    // module would 404 (or 500 on import failure), not fall back silently.
    const response = await request.get(f.url("/docs"));
    expect(response.status()).toBe(200);
  });

  test("build emits the manifest text module and the chunk imports it", () => {
    const assets = fs.readdirSync(distAssets);
    const textModules = assets.filter(
      (a) => a.startsWith("manifest-") && a.endsWith(".txt"),
    );
    expect(textModules.length).toBeGreaterThanOrEqual(1);

    // The payload is the real manifest data, not a stub: `t` is the route
    // trie (matched at runtime), `p` the precomputed entries.
    const raw = fs.readFileSync(path.join(distAssets, textModules[0]!), "utf8");
    const payload = JSON.parse(raw);
    expect(payload).toHaveProperty("t");

    // The asset is raw, un-escaped JSON — never routed through JS minification,
    // so no \\" bloat. This is half the point of the Text module (the other
    // half being no JS compile); an inline literal would ship double-quoted.
    expect(raw.startsWith('{"t":')).toBe(true);
    expect(raw).not.toContain('\\"');

    // Some rsc chunk must import the text module by its emitted filename —
    // an orphaned .txt asset would mean the build silently reverted to the
    // inline literal.
    const imported = assets
      .filter((a) => a.endsWith(".js"))
      .some((a) =>
        fs
          .readFileSync(path.join(distAssets, a), "utf8")
          .includes(textModules[0]!),
      );
    expect(imported).toBe(true);
  });

  test("text-module hygiene: one txt per router, no dual channel, rsc-only", () => {
    const distRoot = path.join(distAssets, "..", "..");
    const assets = fs.readdirSync(distAssets);
    const textModules = assets.filter(
      (a) => a.startsWith("manifest-") && a.endsWith(".txt"),
    );

    // Single-router app: exactly ONE staged manifest. A second .txt means
    // per-router staging collided or duplicated (Bundle Hygiene rule #1 for
    // the Text channel).
    expect(textModules).toHaveLength(1);

    // No dual channel: the trie must not ALSO ship as an inline
    // JSON.parse("<literal>") in any rsc chunk. That regression keeps every
    // functional test green while paying both the compile cost the Text
    // module exists to remove AND double route-data bytes.
    const bigLiteralRe = /JSON\.parse\((["'])((?:\\.|(?!\1).){4096,})\1\)/;
    const dualChannel = walkFiles(path.join(distRoot, "rsc"))
      .filter((f) => f.endsWith(".js"))
      .filter((f) => bigLiteralRe.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(distRoot, f));
    expect(
      dualChannel,
      "route data must ship through the Text module only, not also as an inline literal",
    ).toEqual([]);

    // RSC-only: the staged manifest (name or payload) must not reach the
    // client bundle.
    const payloadHead = fs
      .readFileSync(path.join(distAssets, textModules[0]!), "utf8")
      .slice(0, 200);
    const clientLeaks = walkFiles(path.join(distRoot, "client"))
      .filter((f) => {
        const base = path.basename(f);
        if (base.startsWith("manifest-") && base.endsWith(".txt")) return true;
        if (!base.endsWith(".js")) return false;
        const src = fs.readFileSync(f, "utf8");
        return src.includes(textModules[0]!) || src.includes(payloadHead);
      })
      .map((f) => path.relative(distRoot, f));
    expect(
      clientLeaks,
      "the manifest Text module must not reach the client bundle",
    ).toEqual([]);
  });
});
