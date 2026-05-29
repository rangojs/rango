import { describe, it, expect } from "vitest";
import type { Plugin, ResolvedConfig } from "vite";
import {
  selectForwardableResolvePlugins,
  pickForwardedRunnerConfig,
} from "../utils/forward-user-plugins.js";

const resolveId = () => undefined;
const load = () => undefined;

describe("selectForwardableResolvePlugins", () => {
  it("forwards a third-party resolveId plugin (e.g. vite-tsconfig-paths)", () => {
    const plugins: Plugin[] = [
      { name: "vite-tsconfig-paths", enforce: "pre", resolveId },
    ];
    const out = selectForwardableResolvePlugins(plugins);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("vite-tsconfig-paths");
    expect((out[0] as any).enforce).toBe("pre");
    expect((out[0] as any).resolveId).toBe(resolveId);
  });

  it("denylists Vite core, plugin-rsc, rango, and cloudflare plugins", () => {
    const plugins: Plugin[] = [
      { name: "vite:resolve", resolveId },
      { name: "vite:react-babel", resolveId },
      { name: "rsc", resolveId },
      { name: "rsc:use-client", resolveId },
      { name: "@rangojs/router:discovery", resolveId },
      { name: "@rangojs/router:expose-internal-ids", resolveId },
      { name: "vite-plugin-cloudflare", resolveId },
      { name: "vite-plugin-cloudflare:assets", resolveId },
      { name: "@cloudflare/vite-plugin", resolveId },
    ];
    expect(selectForwardableResolvePlugins(plugins)).toHaveLength(0);
  });

  it("forwards user resolvers whose names merely start with a denylisted word", () => {
    // The denylist must be precise, not a loose prefix/substring -- otherwise an
    // unrelated resolver like `rsc-paths` or `@cloudflare/kv-alias` is dropped and
    // issue #500 reproduces. `vite-tsconfig-paths` (vite- not vite:) also forwards.
    const plugins: Plugin[] = [
      { name: "rsc-paths", resolveId },
      { name: "rsc-alias", resolveId },
      { name: "cloudflare-kv-alias", resolveId },
      { name: "@cloudflare/kv-alias", resolveId },
      { name: "vite-tsconfig-paths", resolveId },
    ];
    expect(selectForwardableResolvePlugins(plugins).map((p) => p.name)).toEqual(
      [
        "rsc-paths",
        "rsc-alias",
        "cloudflare-kv-alias",
        "@cloudflare/kv-alias",
        "vite-tsconfig-paths",
      ],
    );
  });

  it("skips plugins without resolution hooks", () => {
    const plugins: Plugin[] = [
      { name: "transform-only", transform: () => undefined },
      { name: "server-only", configureServer: () => undefined },
    ];
    expect(selectForwardableResolvePlugins(plugins)).toHaveLength(0);
  });

  it("forwards plugins that only expose load", () => {
    const plugins: Plugin[] = [{ name: "virtual-modules", load }];
    const out = selectForwardableResolvePlugins(plugins);
    expect(out).toHaveLength(1);
    expect((out[0] as any).load).toBe(load);
  });

  it("strips non-resolution hooks to avoid double lifecycle", () => {
    const buildStart = () => undefined;
    const config = () => undefined;
    const plugins: Plugin[] = [
      {
        name: "stateful-resolver",
        resolveId,
        load,
        buildStart,
        config,
        configResolved: () => undefined,
        transform: () => undefined,
      } as Plugin,
    ];
    const [out] = selectForwardableResolvePlugins(plugins);
    expect((out as any).resolveId).toBe(resolveId);
    expect((out as any).load).toBe(load);
    expect((out as any).buildStart).toBeUndefined();
    expect((out as any).config).toBeUndefined();
    expect((out as any).configResolved).toBeUndefined();
    expect((out as any).transform).toBeUndefined();
  });

  it("preserves applyToEnvironment gating", () => {
    const applyToEnvironment = () => true;
    const plugins: Plugin[] = [
      { name: "env-gated", resolveId, applyToEnvironment } as Plugin,
    ];
    const [out] = selectForwardableResolvePlugins(plugins);
    expect((out as any).applyToEnvironment).toBe(applyToEnvironment);
  });

  it("drops the apply gate so build-only resolvers survive the serve-mode temp server", () => {
    // config.plugins is already command-filtered by the main server, so a
    // forwarded apply:"build" resolver must carry no apply gate -- otherwise the
    // always-serve discovery temp server would filter it back out. See #500.
    const plugins: Plugin[] = [
      {
        name: "build-only-resolver",
        enforce: "pre",
        resolveId,
        apply: "build",
      },
    ];
    const [out] = selectForwardableResolvePlugins(plugins);
    expect(out.name).toBe("build-only-resolver");
    expect((out as any).resolveId).toBe(resolveId);
    expect((out as any).enforce).toBe("pre");
    expect((out as any).apply).toBeUndefined();
  });

  it("ignores nameless plugins and undefined input", () => {
    expect(selectForwardableResolvePlugins(undefined)).toEqual([]);
    expect(
      selectForwardableResolvePlugins([{ resolveId } as unknown as Plugin]),
    ).toEqual([]);
  });
});

describe("pickForwardedRunnerConfig", () => {
  const base = (over: Partial<ResolvedConfig>): ResolvedConfig =>
    ({
      resolve: {},
      define: undefined,
      oxc: undefined,
      ...over,
    }) as ResolvedConfig;

  it("mirrors only defined resolve fields", () => {
    const cfg = base({
      resolve: {
        alias: [{ find: "@", replacement: "/src" }],
        dedupe: ["react"],
        conditions: ["react-server"],
      } as any,
    });
    const out = pickForwardedRunnerConfig(cfg);
    expect(out.resolve).toEqual({
      alias: [{ find: "@", replacement: "/src" }],
      dedupe: ["react"],
      conditions: ["react-server"],
    });
    expect("mainFields" in out.resolve!).toBe(false);
  });

  it("forwards native resolve.tsconfigPaths so it reaches the temp server", () => {
    // Vite 8's native tsconfig paths resolution is a top-level resolve flag
    // (off by default). The discovery temp server is configFile:false, so the
    // flag is only present during discovery/prerender if it's copied here --
    // otherwise path-aliased imports fail at build time (issue #500 class).
    const cfg = base({ resolve: { tsconfigPaths: true } as any });
    expect(pickForwardedRunnerConfig(cfg).resolve).toEqual({
      tsconfigPaths: true,
    });
  });

  it("omits tsconfigPaths when the user has not set it", () => {
    const out = pickForwardedRunnerConfig(base({ resolve: {} as any }));
    expect("tsconfigPaths" in out.resolve!).toBe(false);
  });

  it("forwards user define", () => {
    const cfg = base({ define: { __FOO__: "1" } as any });
    expect(pickForwardedRunnerConfig(cfg).define).toEqual({ __FOO__: "1" });
  });

  it("pins the RSC JSX runtime over user oxc options", () => {
    const cfg = base({
      oxc: { jsx: "preserve", jsxInject: `import React from "react"` } as any,
    });
    expect(pickForwardedRunnerConfig(cfg).oxc).toEqual({
      jsxInject: `import React from "react"`,
      jsx: { runtime: "automatic", importSource: "react" },
    });
  });

  it("preserves user jsx sub-options while pinning runtime + importSource", () => {
    const cfg = base({
      oxc: {
        jsx: { development: true, runtime: "classic", importSource: "preact" },
      } as any,
    });
    expect(pickForwardedRunnerConfig(cfg).oxc).toEqual({
      jsx: { development: true, runtime: "automatic", importSource: "react" },
    });
  });

  it("supplies the RSC JSX runtime when user disables oxc", () => {
    const cfg = base({ oxc: false as any });
    expect(pickForwardedRunnerConfig(cfg).oxc).toEqual({
      jsx: { runtime: "automatic", importSource: "react" },
    });
  });

  it("does not read or forward the deprecated esbuild option", () => {
    const cfg = base({
      esbuild: { jsx: "preserve", jsxImportSource: "vue" } as any,
    });
    const out = pickForwardedRunnerConfig(cfg);
    expect("esbuild" in out).toBe(false);
    // JSX still pinned via the oxc default path, ignoring esbuild entirely.
    expect(out.oxc).toEqual({
      jsx: { runtime: "automatic", importSource: "react" },
    });
  });
});
