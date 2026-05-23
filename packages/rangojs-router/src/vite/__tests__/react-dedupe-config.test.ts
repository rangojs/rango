import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveConfig, type ResolvedConfig } from "vite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rango } from "../rango";

/**
 * Pins the React dedupe contract independent of install topology.
 *
 * The monorepo hoists a single React to the workspace root, so apps tend to
 * work without `resolve.dedupe`. Real consumers (pnpm strict layout,
 * experimental React pins, third-party "use client" packages) do not, and need
 * exactly one react/react-dom per RSC environment. rango() injects the dedupe
 * automatically; this test asserts it lands in all three resolved environments
 * for both presets so the contract holds regardless of how React is installed.
 */

const ENVIRONMENTS = ["client", "ssr", "rsc"] as const;

async function resolveRangoConfig(
  preset: "node" | "cloudflare",
  command: "serve" | "build",
  root: string,
): Promise<ResolvedConfig> {
  // banner: false keeps the resolve output clean; an empty `root` means the
  // node preset's auto-discover finds no routers, so the resolved config does
  // not depend on this package's own source layout.
  const plugins = await rango({ preset, banner: false });
  return resolveConfig(
    { root, configFile: false, plugins, logLevel: "silent" },
    command,
  );
}

describe("react/react-dom auto-dedupe", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rango-dedupe-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Cover both dev (serve) and production (build): the dedupe injection is not
  // command-conditional, so both must carry the contract.
  for (const preset of ["node", "cloudflare"] as const) {
    for (const command of ["serve", "build"] as const) {
      it(`${preset} preset (${command}) dedupes react+react-dom in client, ssr, and rsc`, async () => {
        const config = await resolveRangoConfig(preset, command, root);

        // Root-level dedupe is set (child environments inherit from it).
        expect(config.resolve?.dedupe).toEqual(
          expect.arrayContaining(["react", "react-dom"]),
        );

        // Every RSC environment resolves the dedupe — this is the contract that
        // prevents duplicate React copies per environment runtime.
        for (const env of ENVIRONMENTS) {
          const envConfig = (config.environments as Record<string, any>)?.[env];
          expect(
            envConfig,
            `${preset}/${command}: environment "${env}" should exist`,
          ).toBeTruthy();
          expect(
            envConfig?.resolve?.dedupe,
            `${preset}/${command}/${env} resolve.dedupe`,
          ).toEqual(expect.arrayContaining(["react", "react-dom"]));
        }
      });
    }
  }
});

describe("react peer dependency contract", () => {
  it("pins a latest-stable React 19 minimum and declares react-dom as a peer", () => {
    const pkgPath = fileURLToPath(
      new URL("../../../package.json", import.meta.url),
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      peerDependencies: Record<string, string>;
    };

    // RSC (use(), useActionState, react-server-dom) is React 19 only, and the
    // floor is held at a current security-patched release: React 18 and older
    // React 19 patches are unsupported, future 19.x patch/minor releases are
    // allowed, React 20 is excluded.
    const RANGE = ">=19.2.6 <20";
    expect(pkg.peerDependencies.react).toBe(RANGE);
    expect(pkg.peerDependencies.react).not.toContain("18");

    // react-dom is imported via the SSR/client virtual entries, so it must be a
    // declared peer alongside react with the same range.
    expect(pkg.peerDependencies["react-dom"]).toBe(RANGE);
  });
});
