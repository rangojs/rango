import { describe, it, expect } from "vitest";
import {
  assertVercelNodeRuntime,
  assertValidVercelFunctionName,
  buildVercelVcConfig,
  buildVercelOutputConfig,
} from "../plugins/vercel-output.js";

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
