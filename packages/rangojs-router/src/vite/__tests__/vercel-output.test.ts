import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertVercelNodeRuntime,
  assertValidVercelFunctionName,
  buildVercelVcConfig,
  buildVercelOutputConfig,
  bundleVercelLauncher,
  resolveRolldownPath,
} from "../plugins/vercel-output.js";

const testRequire = createRequire(import.meta.url);

describe("assertVercelNodeRuntime", () => {
  it("accepts an omitted runtime (defaults to nodejs)", () => {
    expect(() => assertVercelNodeRuntime(undefined)).not.toThrow();
  });

  it("accepts any nodejs* runtime", () => {
    expect(() => assertVercelNodeRuntime("nodejs22.x")).not.toThrow();
    expect(() => assertVercelNodeRuntime("nodejs20.x")).not.toThrow();
  });

  it("rejects the edge runtime with a clear error", () => {
    expect(() => assertVercelNodeRuntime("edge")).toThrow(
      /runtime "edge" is not supported.*Edge runtime is not supported/s,
    );
  });

  it("rejects any non-nodejs runtime", () => {
    expect(() => assertVercelNodeRuntime("python3.12")).toThrow(
      /not supported/,
    );
  });
});

describe("assertValidVercelFunctionName", () => {
  it("accepts a safe single path segment", () => {
    for (const name of ["index", "my-fn", "fn_1", "api.v2"]) {
      expect(() => assertValidVercelFunctionName(name)).not.toThrow();
    }
  });

  it("rejects an empty or whitespace/slash-bearing name", () => {
    for (const bad of ["", " ", "my fn", "a/b", "../evil"]) {
      expect(() => assertValidVercelFunctionName(bad)).toThrow(
        /invalid functionName/,
      );
    }
  });
});

describe("buildVercelVcConfig", () => {
  it("emits a streaming Node serverless config with defaults", () => {
    const c = buildVercelVcConfig({});
    expect(c).toMatchObject({
      runtime: "nodejs24.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 30,
    });
    // Optional fields omitted unless provided.
    expect(c.memory).toBeUndefined();
    expect(c.regions).toBeUndefined();
  });

  it("forwards runtime/maxDuration/memory/regions when set", () => {
    const c = buildVercelVcConfig({
      runtime: "nodejs20.x",
      maxDuration: 60,
      memory: 512,
      regions: ["iad1"],
    });
    expect(c).toMatchObject({
      runtime: "nodejs20.x",
      maxDuration: 60,
      memory: 512,
      regions: ["iad1"],
    });
  });
});

describe("buildVercelOutputConfig", () => {
  it("long-caches hashed assets, then filesystem, then the function (in order)", () => {
    const cfg = buildVercelOutputConfig("index", "assets");
    expect(cfg.version).toBe(3);
    expect(cfg.routes).toEqual([
      {
        src: "/assets/(.*)",
        headers: { "cache-control": "public, max-age=31536000, immutable" },
        continue: true,
      },
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/index" },
    ]);
  });

  it("scopes the cache route to a custom assetsDir and routes to a custom functionName", () => {
    const cfg = buildVercelOutputConfig("app", "static-assets");
    expect(cfg.routes[0]).toMatchObject({ src: "/static-assets/(.*)" });
    expect(cfg.routes[2]).toMatchObject({ dest: "/app" });
  });

  it("regex-escapes assetsDir in the route src (Vercel `src` is a regex)", () => {
    // "static.v2" unescaped would make the dot match any char, stamping
    // immutable cache headers on e.g. function-rendered /static-v2/* pages.
    const cfg = buildVercelOutputConfig("index", "static.v2");
    const src = (cfg.routes[0] as { src: string }).src;
    expect(src).toBe("/static\\.v2/(.*)");
    const re = new RegExp(`^${src}$`);
    expect(re.test("/static.v2/entry-DA6oG_zb.js")).toBe(true);
    expect(re.test("/static-v2/dashboard")).toBe(false);
  });

  it("omits the immutable header route for an empty assetsDir (assets at outDir root)", () => {
    // An empty prefix would emit src "//(.*)" which matches nothing; worse,
    // any broader form would immutable-cache non-hashed root files. Fall back
    // to Vercel's safe default headers instead.
    const cfg = buildVercelOutputConfig("index", "");
    expect(cfg.routes).toEqual([
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/index" },
    ]);
  });
});

describe("bundleVercelLauncher (issue #785)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rango-vercel-launcher-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "app", type: "module" }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeFakeVercelFunctions(): void {
    const pkg = join(root, "node_modules", "@vercel", "functions");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@vercel/functions",
        type: "module",
        exports: { ".": "./index.js" },
      }),
    );
    writeFileSync(
      join(pkg, "index.js"),
      "export function waitUntil(p) { return p; }\n",
    );
  }

  it("resolves rolldown through Vite even when the app does not depend on esbuild", () => {
    const path = resolveRolldownPath(root);
    expect(path).toMatch(/rolldown/);
    expect(path).not.toMatch(/esbuild/);
  });

  it("inlines srvx and @vercel/functions and leaves ./rsc/index.js external", async () => {
    writeFakeVercelFunctions();
    const funcDir = join(root, ".vercel", "output", "functions", "index.func");
    mkdirSync(funcDir, { recursive: true });
    await bundleVercelLauncher({
      root,
      funcDir,
      srvxNodePath: testRequire.resolve("srvx/node"),
    });
    const out = readFileSync(join(funcDir, "index.mjs"), "utf8");
    expect(out).toMatch(/from\s*["']\.\/rsc\/index\.js["']/);
    expect(out).not.toMatch(/from\s*["']@vercel\/functions["']/);
    expect(out).not.toMatch(/\besbuild\b/);
    expect(out).toMatch(/waitUntil/);
    expect(out).toMatch(/toNodeHandler/);
  });

  it("rewrites a missing @vercel/functions resolve into a rango error", async () => {
    // A broken local package shadows any hoisted copy so this is not a
    // walk-up false negative under vitest (cwd is the router package).
    const pkg = join(root, "node_modules", "@vercel", "functions");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@vercel/functions",
        type: "module",
        exports: { ".": "./missing.js" },
      }),
    );
    const funcDir = join(root, ".vercel", "output", "functions", "index.func");
    mkdirSync(funcDir, { recursive: true });
    await expect(
      bundleVercelLauncher({
        root,
        funcDir,
        srvxNodePath: testRequire.resolve("srvx/node"),
      }),
    ).rejects.toThrow(/could not resolve "@vercel\/functions"/);
  });
});
