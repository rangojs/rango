import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePerRouterModule } from "../virtual-module-codegen";
import { createDiscoveryState, type DiscoveryState } from "../state";

// A trie whose serialized form clears MANIFEST_EXTERNALIZE_THRESHOLD (512KB).
// ~90 bytes/leaf, so 8000 leaves ~= 700KB. SMALL stays well under.
function bigTrie(n: number) {
  const s: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    s[`route-segment-number-${i}`] = {
      r: {
        n: `route.name.number.${i}`,
        sp: "",
        a: ["M0L0", `M0L0R${i}`],
        pa: ["locale", "id"],
      },
    };
  }
  return { s };
}
const BIG = bigTrie(8000);
const SMALL = bigTrie(3);
const ENTRIES = [{ staticPrefix: "", routes: { home: "/" } }];

let tmpRoot: string;
let savedOverride: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rango-vmc-"));
  savedOverride = process.env.RANGO_MANIFEST_TEXT;
  delete process.env.RANGO_MANIFEST_TEXT;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (savedOverride === undefined) delete process.env.RANGO_MANIFEST_TEXT;
  else process.env.RANGO_MANIFEST_TEXT = savedOverride;
});

function makeState(
  preset: "node" | "cloudflare" | "vercel",
  opts: { isBuildMode?: boolean; trie?: unknown } = {},
  routerId = "r1",
): DiscoveryState {
  const s = createDiscoveryState(undefined, { preset });
  s.projectRoot = tmpRoot;
  s.isBuildMode = opts.isBuildMode ?? true;
  s.perRouterManifests.push({ id: routerId, routeManifest: { home: "/" } });
  s.perRouterManifestDataMap.set(routerId, { home: "/" });
  s.perRouterTrieMap.set(routerId, opts.trie ?? BIG);
  s.perRouterPrecomputedMap.set(routerId, ENTRIES);
  return s;
}

const ragoDir = (root: string) => join(root, "node_modules", ".rango");

describe("generatePerRouterModule — cloudflare Text module channel", () => {
  it("emits a .txt Text-module import above the threshold and stages un-escaped JSON", () => {
    const code = generatePerRouterModule(makeState("cloudflare"), "r1");

    expect(code).toContain("import __manifestJson from");
    expect(code).toContain(".txt");
    expect(code).toContain("export const trie = __manifestData.t;");
    expect(code).toContain(
      "export const precomputedEntries = __manifestData.p;",
    );
    expect(code).not.toContain("export const trie = JSON.parse(");
    expect(code).not.toContain("?raw");
    expect(code).not.toContain("readFileSync");

    const files = readdirSync(ragoDir(tmpRoot));
    expect(files).toHaveLength(1);
    const staged = readFileSync(join(ragoDir(tmpRoot), files[0]!), "utf8");
    // Staged raw and un-escaped (no \\" bloat) — this is the whole point.
    expect(staged.startsWith('{"t":')).toBe(true);
    expect(JSON.parse(staged)).toEqual({ t: BIG, p: ENTRIES });
  });

  it("distinct router ids never share a staged file (collision-safe filename)", () => {
    const s1 = makeState("cloudflare", {}, "a/b");
    // add a second router with a colliding sanitized id into the same state
    s1.perRouterManifests.push({ id: "a.b", routeManifest: { home: "/" } });
    s1.perRouterManifestDataMap.set("a.b", { home: "/" });
    s1.perRouterTrieMap.set("a.b", BIG);
    s1.perRouterPrecomputedMap.set("a.b", ENTRIES);
    generatePerRouterModule(s1, "a/b");
    generatePerRouterModule(s1, "a.b");
    // Two distinct staged files, not one overwrite.
    expect(readdirSync(ragoDir(tmpRoot))).toHaveLength(2);
  });

  it("below the threshold keeps the inline literal", () => {
    const code = generatePerRouterModule(
      makeState("cloudflare", { trie: SMALL }),
      "r1",
    );
    expect(code).toContain("export const trie = JSON.parse(");
    expect(code).not.toContain(".txt");
    expect(existsSync(ragoDir(tmpRoot))).toBe(false);
  });

  it("dev keeps the inline literal even above the threshold", () => {
    const code = generatePerRouterModule(
      makeState("cloudflare", { isBuildMode: false }),
      "r1",
    );
    expect(code).toContain("export const trie = JSON.parse(");
    expect(code).not.toContain(".txt");
  });

  it("RANGO_MANIFEST_TEXT=1 emits the Text module below the threshold", () => {
    process.env.RANGO_MANIFEST_TEXT = "1";
    const code = generatePerRouterModule(
      makeState("cloudflare", { trie: SMALL }),
      "r1",
    );
    expect(code).toContain(".txt");
    expect(code).toContain("import __manifestJson from");
  });

  it("RANGO_MANIFEST_TEXT=0 forces the inline literal above the threshold", () => {
    process.env.RANGO_MANIFEST_TEXT = "0";
    const code = generatePerRouterModule(makeState("cloudflare"), "r1");
    expect(code).toContain("export const trie = JSON.parse(");
    expect(code).not.toContain(".txt");
  });
});

describe("generatePerRouterModule — carries only derived match data", () => {
  it("gen-file router: bare import for the HMR edge, no manifest re-export", () => {
    const s = makeState("node", { trie: SMALL });
    s.perRouterManifests[0]!.sourceFile = join(tmpRoot, "src", "router.ts");
    const code = generatePerRouterModule(s, "r1");

    // Edge-only import: gen-file changes must invalidate this module in dev.
    expect(code).toContain("router.named-routes.gen.js");
    expect(code).toMatch(/import "[^"]*router\.named-routes\.gen\.js";/);
    // The name->path map lives solely in the eager module (setRouterManifest).
    expect(code).not.toContain("export const manifest");
    expect(code).not.toContain("__flat");
    expect(code).toContain("export const trie = JSON.parse(");
    expect(code).toContain("export const precomputedEntries = JSON.parse(");
  });

  it("router without gen file: no manifest export, data only", () => {
    const code = generatePerRouterModule(
      makeState("node", { trie: SMALL }),
      "r1",
    );
    expect(code).not.toContain("export const manifest");
    expect(code).toContain("export const trie = JSON.parse(");
  });
});

describe("generatePerRouterModule — node/vercel keep the inline literal", () => {
  for (const preset of ["node", "vercel"] as const) {
    it(`${preset}: inline literal above the threshold (no channel off cloudflare)`, () => {
      const code = generatePerRouterModule(makeState(preset), "r1");
      expect(code).toContain("export const trie = JSON.parse(");
      expect(code).not.toContain(".txt");
      expect(code).not.toContain("?raw");
      expect(code).not.toContain("readFileSync");
      expect(existsSync(ragoDir(tmpRoot))).toBe(false);
    });

    it(`${preset}: RANGO_MANIFEST_TEXT=1 does NOT force a channel (Text is cloudflare-only)`, () => {
      process.env.RANGO_MANIFEST_TEXT = "1";
      const code = generatePerRouterModule(makeState(preset), "r1");
      expect(code).toContain("export const trie = JSON.parse(");
      expect(code).not.toContain(".txt");
    });
  }
});
