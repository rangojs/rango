import { fileURLToPath } from "node:url";
import {
  createServer,
  type RunnableDevEnvironment,
  type ViteDevServer,
} from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

// A real Vite module runner (#1186): the full reload the dep optimizer sends,
// with the re-created router's module still evaluating when the dropped
// router looks for it.

const ROOT = fileURLToPath(
  new URL("./__fixtures__/runner-reload/", import.meta.url),
);
const ROUTER_FILE = fileURLToPath(
  new URL("./__fixtures__/runner-reload/app-router.ts", import.meta.url),
);

interface AppRouterModule {
  router: { id: string };
  handoff: typeof import("../dev-reload-handoff.js");
}

const slow = globalThis as { __rangoRunnerReloadSlow?: { started: boolean } };
let server: ViteDevServer | undefined;

afterEach(async () => {
  delete slow.__rangoRunnerReloadSlow;
  await server?.close();
  server = undefined;
});

describe("routerAfterRunnerReload on a Vite module runner", () => {
  it("waits for the router a slow re-import registers", async () => {
    server = await createServer({
      configFile: false,
      root: ROOT,
      logLevel: "silent",
      appType: "custom",
      server: { middlewareMode: true, ws: false },
    });
    const ssr = server.environments.ssr as RunnableDevEnvironment;
    const dropped = (await ssr.runner.import(ROUTER_FILE)) as AppRouterModule;

    slow.__rangoRunnerReloadSlow = { started: false };
    ssr.moduleGraph.invalidateAll();
    ssr.hot.send({ type: "full-reload", path: "*" });
    // The re-import is evaluating the router's module, held before it
    // registers.
    await vi.waitFor(() => {
      expect(dropped.handoff.droppedByRunnerReload()).toBe(true);
      expect(slow.__rangoRunnerReloadSlow?.started).toBe(true);
    });

    const recreated = await dropped.handoff.routerAfterRunnerReload(
      dropped.router.id,
      ROUTER_FILE,
    );
    expect(recreated).toBeDefined();
    expect(recreated).not.toBe(dropped.router);
    const fresh = (await ssr.runner.import(ROUTER_FILE)) as AppRouterModule;
    expect(recreated).toBe(fresh.router);
  });
});
