import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBuildEnv } from "../router-discovery";

/**
 * buildEnv: "auto" must read the wrangler config of the Vite root, not of
 * process.cwd() (issue #1037). A stub `wrangler` package records the options
 * getPlatformProxy() receives.
 */

type Recorded = { options: unknown }[];

function writeStubWrangler(projectDir: string): void {
  const pkgDir = join(projectDir, "node_modules", "wrangler");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "wrangler", version: "0.0.0", main: "index.cjs" }),
  );
  writeFileSync(
    join(pkgDir, "index.cjs"),
    `exports.getPlatformProxy = async (options) => {
  (globalThis.__rangoProxyCalls ??= []).push({ options });
  return { env: { STUB: true }, dispose: async () => {} };
};\n`,
  );
}

const calls = (): Recorded =>
  (globalThis as { __rangoProxyCalls?: Recorded }).__rangoProxyCalls ?? [];

describe("buildEnv: auto wrangler config lookup (issue #1037)", () => {
  let base: string;
  let root: string;
  let otherCwd: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "rango-build-env-")));
    root = join(base, "app");
    otherCwd = join(base, "elsewhere");
    mkdirSync(root, { recursive: true });
    mkdirSync(otherCwd, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeStubWrangler(root);
    (globalThis as { __rangoProxyCalls?: Recorded }).__rangoProxyCalls = [];
    process.chdir(otherCwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });

  const run = () =>
    resolveBuildEnv("auto", {
      root,
      mode: "production",
      command: "build",
      preset: "cloudflare",
    });

  it("passes the config under the root and persists state under the root", async () => {
    writeFileSync(join(root, "wrangler.json"), "{}");
    await run();
    expect(calls()).toHaveLength(1);
    expect(calls()[0].options).toEqual({
      configPath: join(root, "wrangler.json"),
      persist: { path: join(root, ".wrangler", "state", "v3") },
    });
  });

  it("follows wrangler's file-name order (json, jsonc, toml)", async () => {
    writeFileSync(join(root, "wrangler.toml"), "");
    writeFileSync(join(root, "wrangler.jsonc"), "{}");
    await run();
    expect(calls()[0].options).toMatchObject({
      configPath: join(root, "wrangler.jsonc"),
    });
  });

  it("searches upward from the root", async () => {
    const nested = join(root, "packages", "web");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "wrangler.json"), "{}");
    await resolveBuildEnv("auto", {
      root: nested,
      mode: "production",
      command: "build",
      preset: "cloudflare",
    });
    // The stub is resolved from `nested` upward too (root/node_modules).
    // State stays under the Vite root, where the Cloudflare Vite plugin reads
    // it, not next to the config found above it.
    expect(calls()[0].options).toEqual({
      configPath: join(root, "wrangler.json"),
      persist: { path: join(nested, ".wrangler", "state", "v3") },
    });
  });

  it("calls getPlatformProxy() with no options when no config is found", async () => {
    await run();
    expect(calls()).toHaveLength(1);
    expect(calls()[0].options).toBeUndefined();
  });
});
