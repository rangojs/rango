import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViteDevServer } from "vite";
import { createTempRscServer } from "../router-discovery.js";
import { createDiscoveryState } from "../discovery/state.js";

// #947: buildStart installs the route tries into the build temp server's RSC
// realm and the post-build shell phase reuses that realm. writeRouteTypesFiles
// rewrites <router>.named-routes.gen.ts in between; that write must not reload
// the realm.

const GEN_FILE = "router.named-routes.gen.ts";

function writeFixture(root: string): string {
  // entry -> router -> gen: the entry has no importers, so an update to the gen
  // file dead-ends there and Vite's fallback is a full reload.
  writeFileSync(
    join(root, "entry.ts"),
    'import { names } from "./router.js";\nexport const realm = { names };\n',
  );
  writeFileSync(
    join(root, "router.ts"),
    'import { NamedRoutes } from "./router.named-routes.gen.js";\nexport const names = Object.keys(NamedRoutes);\n',
  );
  writeFileSync(
    join(root, GEN_FILE),
    'export const NamedRoutes = { home: "/" } as const;\n',
  );
  return join(root, "entry.ts");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rewrite the gen file, then report whether the runner re-evaluated the entry
 * within `windowMs` (a full reload re-imports entrypoints, so a later import
 * returns a different module namespace).
 */
async function entryReloadedAfterGenWrite(
  server: ViteDevServer,
  root: string,
  entryPath: string,
  windowMs: number,
): Promise<boolean> {
  const runner = (server.environments as Record<string, any>).rsc.runner;
  const first = await runner.import(entryPath);
  // A real watcher emits "ready" after its initial scan; the build-mode noop
  // watcher never does, so the wait is bounded.
  await Promise.race([
    new Promise((resolve) => server.watcher.once("ready", resolve)),
    delay(1_000),
  ]);
  writeFileSync(
    join(root, GEN_FILE),
    'export const NamedRoutes = { home: "/", about: "/about" } as const;\n',
  );
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await delay(25);
    if ((await runner.import(entryPath)) !== first) return true;
  }
  return false;
}

describe("createTempRscServer realm stability (#947)", () => {
  let root: string;
  let server: ViteDevServer | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rango-temp-realm-"));
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  async function startServer(forceBuild: boolean): Promise<{
    server: ViteDevServer;
    entryPath: string;
  }> {
    const entryPath = writeFixture(root);
    const state = createDiscoveryState(entryPath, undefined);
    state.projectRoot = root;
    server = await createTempRscServer(state, { forceBuild });
    return { server, entryPath };
  }

  it("build mode keeps the RSC realm when a module-graph file is rewritten", async () => {
    const { server, entryPath } = await startServer(true);
    expect(
      await entryReloadedAfterGenWrite(server, root, entryPath, 1_500),
    ).toBe(false);
  }, 20_000);

  // Control: the same write reloads the dev temp server's realm, so the build
  // assertion above is not vacuous (the watcher does see the write).
  it("dev mode still reloads the RSC realm on the same write", async () => {
    const { server, entryPath } = await startServer(false);
    expect(
      await entryReloadedAfterGenWrite(server, root, entryPath, 5_000),
    ).toBe(true);
  }, 20_000);
});
