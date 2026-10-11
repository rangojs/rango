import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIRTUAL_ROUTES_MANIFEST_ID,
  type DiscoveryState,
} from "../discovery/state.js";

// The dev recovery wiring in router-discovery.ts's configureServer, driven
// through the plugin against fake dev servers. discoverRouters and the gen-file
// writers are stubbed: their own behavior is covered by
// discover-routers-reload.test.ts and the route-types tests.

const discoverRouters = vi.hoisted(() => vi.fn());
vi.mock("../discovery/discover-routers.js", () => ({ discoverRouters }));
vi.mock("../discovery/route-types-writer.js", () => ({
  writeCombinedRouteTypesWithTracking: vi.fn(),
  writeRouteTypesFiles: vi.fn(),
  supplementGenFilesWithRuntimeRoutes: vi.fn(),
}));

const { createRouterDiscoveryPlugin } = await import("../router-discovery.js");

const MANIFEST_MODULE_ID = `\0${VIRTUAL_ROUTES_MANIFEST_ID}`;
const ROUTE_MANIFEST = { home: "/" };

let root: string;
let entry: string;
let closeServer: (() => void) | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rango-dev-discovery-recovery-"));
  entry = join(root, "src", "router.tsx");
  discoverRouters.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  closeServer?.();
  closeServer = undefined;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** What a successful discoverRouters pass commits. */
function commitManifest(state: DiscoveryState): void {
  state.mergedRouteManifest = { ...ROUTE_MANIFEST };
  state.perRouterManifests = [{ id: "app", routeManifest: ROUTE_MANIFEST }];
  state.perRouterManifestDataMap = new Map([["app", ROUTE_MANIFEST]]);
}

function createServerModule() {
  return {
    RouterRegistry: new Map(),
    setManifestReadyPromise: vi.fn(),
    clearAllRouterData: vi.fn(),
    setCachedManifest: vi.fn(),
    setRouterManifest: vi.fn(),
  };
}

/** A main dev server; `runner: false` is Cloudflare (workerd, no Node runner). */
function createDevServer({ runner }: { runner: boolean }) {
  const serverMod = createServerModule();
  const manifestModule = { id: MANIFEST_MODULE_ID };
  const rsc = {
    runner: runner
      ? {
          import: vi.fn(async (id: string) =>
            id === "@rangojs/router/server" ? serverMod : {},
          ),
        }
      : undefined,
    moduleGraph: {
      getModuleById: (id: string) =>
        id === MANIFEST_MODULE_ID ? manifestModule : undefined,
      invalidateModule: vi.fn(),
      invalidateAll: vi.fn(),
      getModulesByFile: () => undefined,
    },
    hot: { send: vi.fn() },
  };
  const client = { hot: { on: vi.fn(), send: vi.fn() } };
  const httpServer = Object.assign(new EventEmitter(), { listening: true });
  const watcher = new EventEmitter();
  const server = {
    environments: { rsc, ssr: {}, client },
    httpServer,
    watcher,
    middlewares: { use: vi.fn() },
    config: { server: { port: 5173 }, logger: { error: vi.fn() } },
    resolvedUrls: { local: ["http://localhost:5173/"] },
  };
  return { server, serverMod, rsc, client, manifestModule, watcher };
}

type DevServer = ReturnType<typeof createDevServer>;

function startPlugin(dev: DevServer, preset?: "cloudflare") {
  const plugin = createRouterDiscoveryPlugin(
    entry,
    preset ? { preset } : undefined,
  ) as any;
  plugin.configResolved({
    root,
    command: "serve",
    mode: "development",
    resolve: { alias: [] },
    plugins: [],
  });
  plugin.configureServer(dev.server);
  closeServer = () => dev.server.httpServer.emit("close");
  return {
    /** The routes-manifest module; awaits the discovery gate like a request. */
    loadManifestModule: (): Promise<string> =>
      plugin.load.call({}, MANIFEST_MODULE_ID),
  };
}

/** Save a source file the way an editor does: write it, then a watcher event. */
function save(dev: DevServer, rel: string, source: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  dev.watcher.emit("change", file);
}

const HELPER_SOURCE = "export const label = 'fixed';\n";
const URLS_SOURCE =
  'import { urls } from "@rangojs/router";\nexport const urlpatterns = urls(() => []);\n';

describe("Node dev server: recovery after a failed cold discovery", () => {
  /** Boots with a failing cold discovery; later passes commit. */
  async function bootFailed() {
    const dev = createDevServer({ runner: true });
    discoverRouters
      .mockRejectedValueOnce(new Error("cold discovery failed"))
      .mockImplementation(async (state: DiscoveryState) => {
        commitManifest(state);
        return dev.serverMod;
      });
    const plugin = startPlugin(dev);
    const coldModule = await plugin.loadManifestModule();
    expect(discoverRouters).toHaveBeenCalledTimes(1);
    expect(coldModule).not.toContain("setRouterManifest(");
    return { dev, plugin };
  }

  it("re-runs discovery on the next source save, even one that defines no routes", async () => {
    const { dev } = await bootFailed();

    // Recovery mode (lastDiscoveryError) lets a non-route file through the
    // watcher's content sniff, and canRefreshRuntimeDiscovery lets it rediscover.
    save(dev, "src/helper.ts", HELPER_SOURCE);

    await vi.waitFor(() => expect(discoverRouters).toHaveBeenCalledTimes(2));
  });

  it("holds the routes-manifest module until the recovering pass commits", async () => {
    const { dev, plugin } = await bootFailed();

    save(dev, "src/helper.ts", HELPER_SOURCE);
    // Requested right after the save, before the watcher's debounce runs
    // discovery: the gate the save armed holds it until the pass commits.
    const code = await plugin.loadManifestModule();

    expect(discoverRouters).toHaveBeenCalledTimes(2);
    expect(code).toContain('setRouterManifest("app"');
  });

  it("invalidates the routes-manifest module once, on the recovering pass", async () => {
    const { dev, plugin } = await bootFailed();
    const { invalidateModule } = dev.rsc.moduleGraph;

    save(dev, "src/helper.ts", HELPER_SOURCE);
    await plugin.loadManifestModule();
    // The no-manifest module has no gen-file import, so no gen write would
    // ever invalidate it.
    expect(invalidateModule).toHaveBeenCalledTimes(1);
    expect(invalidateModule).toHaveBeenCalledWith(dev.manifestModule);
    expect(dev.serverMod.clearAllRouterData).toHaveBeenCalled();

    // A later route edit, with a committed manifest: the gen-file import
    // edge refreshes the module, so no explicit invalidation.
    save(dev, "src/urls.tsx", URLS_SOURCE);
    await plugin.loadManifestModule();
    expect(discoverRouters).toHaveBeenCalledTimes(3);
    expect(invalidateModule).toHaveBeenCalledTimes(1);
  });
});
