import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveConfig, build, type ResolvedConfig } from "vite";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rango } from "../rango";

/**
 * Pins the server-side build target (issue #729).
 *
 * Vite 8 defaults every environment's `build.target` to the browser baseline
 * (`baseline-widely-available` → chrome111/…, ≈ES2022) with no server carve-out,
 * so the `ssr`/`rsc` bundles — which only run on Node/workerd — were compiled
 * for browsers, downleveling modern syntax for nothing. rango pins the node and
 * vercel server envs to `esnext`; the `client` env is left at the browser
 * baseline, and the cloudflare preset is left to `@cloudflare/vite-plugin`
 * (which imposes its own `es2024`).
 *
 * `build.target` only takes effect at build, so these assert `command: "build"`.
 */

async function resolveRangoConfig(
  preset: "node" | "vercel" | "cloudflare",
  root: string,
): Promise<ResolvedConfig> {
  // banner:false keeps output clean; an empty `root` means the node/vercel
  // auto-discover finds no routers, so the resolved config does not depend on
  // this package's own source layout.
  const plugins = await rango({ preset, banner: false });
  return resolveConfig(
    { root, configFile: false, plugins, logLevel: "silent" },
    "build",
  );
}

const target = (config: ResolvedConfig, env: string) =>
  config.environments[env]?.build?.target;

describe("server build.target contract (issue #729)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rango-server-target-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const preset of ["node", "vercel"] as const) {
    it(`${preset} preset pins ssr+rsc to esnext and leaves client at the browser baseline`, async () => {
      const config = await resolveRangoConfig(preset, root);

      expect(target(config, "ssr")).toBe("esnext");
      expect(target(config, "rsc")).toBe("esnext");

      // The client env must stay at the browser baseline — shipping esnext to
      // browsers would drop the intended download floor.
      expect(target(config, "client")).not.toBe("esnext");
      expect(target(config, "client")).toEqual(
        expect.arrayContaining(["chrome111"]),
      );
    });
  }

  it("cloudflare preset does not pin a server target (the @cloudflare/vite-plugin owns es2024)", async () => {
    const config = await resolveRangoConfig("cloudflare", root);

    // rango sets no server target on cloudflare; the CF plugin's config() merges
    // after ours and imposes es2024. Without the CF plugin present here it falls
    // to Vite's default — the point is only that rango leaves it alone (not our
    // esnext pin), so the CF plugin's later value wins in a real CF app.
    expect(target(config, "ssr")).not.toBe("esnext");
    expect(target(config, "rsc")).not.toBe("esnext");
  });
});

/**
 * Demonstrates the downleveling the esnext pin prevents, on the real
 * vite@8/rolldown/oxc toolchain: a server (`build.ssr`) module using Explicit
 * Resource Management `using` is rewritten to an oxc `_usingCtx()` runtime helper
 * at the browser-baseline default, and emitted verbatim at `esnext`. Hermetic
 * (no app config), so the app-level `oxc.target` confound does not apply — oxc
 * lowers `.ts`/`.tsx` at transform time, but here nothing sets `oxc.target`, so
 * `build.target` is the sole ceiling.
 */
describe("esnext server target keeps modern syntax verbatim (issue #729)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rango-erm-probe-"));
    writeFileSync(
      join(root, "erm.ts"),
      "export function acquire() {\n" +
        "  using res = { value: 42, [Symbol.dispose]() {} };\n" +
        "  return res.value;\n" +
        "}\n",
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function buildServerModule(
    buildTarget: "esnext" | undefined,
  ): Promise<string> {
    const outDir = join(root, "out-" + (buildTarget ?? "baseline"));
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      build: {
        outDir,
        minify: false,
        ssr: join(root, "erm.ts"),
        // undefined → Vite's baseline-widely-available (browser) default
        target: buildTarget,
        rollupOptions: {
          output: { entryFileNames: "erm.js" },
        },
      },
    });
    return readFileSync(join(outDir, "erm.js"), "utf8");
  }

  it("downlevels `using` to a _usingCtx helper at the browser-baseline default", async () => {
    const out = await buildServerModule(undefined);
    expect(out).toMatch(/_usingCtx/);
    expect(out).not.toMatch(/using\s+res\b/);
  });

  it("emits `using` verbatim at esnext (no runtime helper)", async () => {
    const out = await buildServerModule("esnext");
    expect(out).toMatch(/using\s+res\b/);
    expect(out).not.toMatch(/_usingCtx/);
  });
});
