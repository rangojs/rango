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
const ENTRY_FILE = fileURLToPath(
  new URL("./__fixtures__/runner-reload/app-entry.ts", import.meta.url),
);

interface AppRouterModule {
  router: { id: string };
  handoff: typeof import("../dev-reload-handoff.js");
}

interface AppEntryModule {
  handler: (request: Request) => Promise<Response>;
  handoff: typeof import("../dev-reload-handoff.js");
}

const slow = globalThis as {
  __rangoRunnerReloadSlow?: { started: boolean };
  __rangoRunnerReloadEntry?: { realms: number; gate?: Promise<void> };
};
let server: ViteDevServer | undefined;

afterEach(async () => {
  delete slow.__rangoRunnerReloadSlow;
  delete slow.__rangoRunnerReloadEntry;
  await server?.close();
  server = undefined;
});

async function createRunnerServer(): Promise<RunnableDevEnvironment> {
  server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, ws: false },
  });
  return server.environments.ssr as RunnableDevEnvironment;
}

/**
 * Sends the dep optimizer's full reload and waits until it dropped `dropped`
 * and the runner's re-import is held in slow.ts, before the fresh entry's
 * last statement.
 */
async function reloadHeldInReimport(
  ssr: RunnableDevEnvironment,
  dropped: { handoff: AppEntryModule["handoff"] },
): Promise<void> {
  slow.__rangoRunnerReloadSlow = { started: false };
  ssr.moduleGraph.invalidateAll();
  ssr.hot.send({ type: "full-reload", path: "*" });
  await vi.waitFor(() => {
    expect(dropped.handoff.droppedByRunnerReload()).toBe(true);
    expect(slow.__rangoRunnerReloadSlow?.started).toBe(true);
  });
}

describe("routerAfterRunnerReload on a Vite module runner", () => {
  it("waits for the router a slow re-import registers", async () => {
    const ssr = await createRunnerServer();
    const dropped = (await ssr.runner.import(ROUTER_FILE)) as AppRouterModule;

    // The re-import is evaluating the router's module, held before it
    // registers.
    await reloadHeldInReimport(ssr, dropped);

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

describe("serveEntryAcrossRunnerReload on a Vite module runner", () => {
  /**
   * Imports the entry, starts `method` on it held until `reloads` full
   * reloads landed, each while the previous re-import was still held in
   * slow.ts, then releases it.
   */
  async function serveAcrossReloads(method: "GET" | "POST", reloads = 1) {
    const ssr = await createRunnerServer();
    const dropped = (await ssr.runner.import(ENTRY_FILE)) as AppEntryModule;
    let release!: () => void;
    slow.__rangoRunnerReloadEntry!.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = dropped.handler(
      new Request("http://localhost/", { method }),
    );
    for (let i = 0; i < reloads; i++) await reloadHeldInReimport(ssr, dropped);
    release();
    return { ssr, response: await response };
  }

  it("re-runs a GET in flight on the entry the reload re-evaluated, once its last statement ran", async () => {
    const { ssr, response } = await serveAcrossReloads("GET");
    expect(await response.text()).toBe("GET realm 2");
    const fresh = (await ssr.runner.import(ENTRY_FILE)) as AppEntryModule;
    expect(fresh.handoff.registeredEntryHandler()).toBe(fresh.handler);
  });

  it("follows a second reload that lands while the first re-import evaluates", async () => {
    // The edit's reload, then the route-gen write's: the second clears the
    // first re-import's copy before its last statement ran.
    const { response } = await serveAcrossReloads("GET", 2);
    expect(await response.text()).toBe("GET realm 3");
  });

  it("answers a POST in flight on the entry it started on", async () => {
    const { response } = await serveAcrossReloads("POST");
    expect(await response.text()).toBe("POST realm 1");
  });
});
