import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlReference } from "../../../client-urls/server-projection.js";
import { discoverRouters } from "../discover-routers.js";
import { canRefreshRuntimeDiscovery, createDiscoveryState } from "../state.js";
import { generateRoutesManifestModule } from "../virtual-module-codegen.js";

// A Vite module runner full reload clears its evaluated-module cache. One that
// lands while discovery imports the entry splits the realm: the router module
// already bound to the old `@rangojs/router/server` registers there, while
// urls.tsx re-evaluates against a fresh copy whose projection Map is empty
// ("include() could not resolve the server projection" on a cold dev start). Each realm below is a separate module graph (vi.resetModules).

const ENTRY = "/app/src/router.tsx";
const REFERENCE_ID = "/src/urls/client-urls.tsx#default";
const MANIFEST = {
  "clientUrls.index": "/client-urls-e2e",
  "clientUrls.detail": "/client-urls-e2e/:id",
};

function Page(): null {
  return null;
}

const definition = clientUrls(({ path }) => [
  path("/", Page, { name: "index" }),
  path("/:id", Page, { name: "detail" }),
]);

interface Realm {
  server: typeof import("../../../server.js");
  urls: (typeof import("../../../urls/urls-function.js"))["urls"];
  build: typeof import("../../../build/generate-manifest.js");
}

async function loadRealm(): Promise<Realm> {
  vi.resetModules();
  const server = await import("../../../server.js");
  const { urls } = await import("../../../urls/urls-function.js");
  const build = await import("../../../build/generate-manifest.js");
  return { server, urls, build };
}

function clientReference(id: string): ClientUrlReference {
  return Object.assign(
    function ClientUrlDefinition(): null {
      return null;
    },
    { $$typeof: Symbol.for("react.client.reference"), $$id: id },
  ) as unknown as ClientUrlReference;
}

/** urls.tsx: a server tree mounting the clientUrls() client reference. */
function appPatterns(realm: Realm) {
  return realm.urls(({ include }) => [
    include(
      "/client-urls-e2e",
      clientReference(REFERENCE_ID) as unknown as typeof definition,
      { name: "clientUrls" },
    ),
  ]);
}

/**
 * Fake rsc runner. Every entry import up to `reloads` reloads mid-import: the
 * router (bound to the realm current when the import started) registers in
 * that realm, urls.tsx in the next one.
 */
function createRscEnv(realms: Realm[], reloads: number) {
  let current = 0;
  let entryImports = 0;
  const runner = {
    async import(id: string): Promise<unknown> {
      const realm = realms[current % realms.length];
      if (id === "@rangojs/router/server") return realm.server;
      if (id === "@rangojs/router/build") return realm.build;
      if (id !== ENTRY) throw new Error(`unexpected import ${id}`);
      entryImports++;
      if (entryImports <= reloads) current++;
      const urlsRealm = realms[current % realms.length];
      (realm.server.RouterRegistry as Map<string, unknown>).set("app", {
        id: "app",
        urlpatterns: appPatterns(urlsRealm),
      });
      return {};
    },
  };
  return {
    rscEnv: { runner },
    entryImports: () => entryImports,
    currentRealm: () => realms[current % realms.length],
  };
}

const ssrEnv = {
  runner: {
    async import(): Promise<Record<string, unknown>> {
      return { default: definition };
    },
  },
};

let projectRoot: string;
let realms: Realm[];

// Two full module graphs take several seconds on a loaded machine.
beforeAll(async () => {
  realms = [await loadRealm(), await loadRealm()];
}, 60_000);

function createState() {
  const state = createDiscoveryState(ENTRY, undefined);
  state.projectRoot = projectRoot;
  state.clientUrlSourceByReferenceId = new Map([
    [REFERENCE_ID, join(projectRoot, "src/urls/client-urls.tsx")],
  ]);
  return state;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "rango-discovery-reload-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  for (const realm of realms) realm.server.RouterRegistry.clear();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("discoverRouters — module runner reload during the pass", () => {
  it("redoes the pass in the reloaded realm instead of installing projections on the stale one", async () => {
    const { rscEnv, entryImports, currentRealm } = createRscEnv(realms, 1);
    const state = createState();

    const serverMod = await discoverRouters(state, rscEnv, ssrEnv);

    expect(entryImports()).toBe(2);
    expect(serverMod).toBe(currentRealm().server);
    expect(state.mergedRouteManifest).toEqual(MANIFEST);
    expect([...state.clientUrlProjectionMap!.keys()]).toEqual([REFERENCE_ID]);
  });

  it("gives up after a bounded number of reloaded passes and commits nothing", async () => {
    const { rscEnv, entryImports } = createRscEnv(realms, Infinity);
    const state = createState();

    await expect(discoverRouters(state, rscEnv, ssrEnv)).rejects.toThrow(
      /module runner reloaded during 3 consecutive discovery passes/,
    );
    expect(entryImports()).toBe(3);
    expect(state.mergedRouteManifest).toBeNull();
    expect(state.perRouterManifests).toEqual([]);
  });
});

describe("recovery after a failed cold discovery", () => {
  it("replays the failed pass's projections and lets the watcher rediscover", async () => {
    const state = createState();
    await expect(
      discoverRouters(state, createRscEnv(realms, Infinity).rscEnv, ssrEnv),
    ).rejects.toThrow(/did not settle/);
    // router-discovery.ts records the cold failure (recovery mode).
    state.lastDiscoveryError = { message: "did not settle", at: Date.now() };

    expect(state.perRouterManifests).toEqual([]);
    expect(generateRoutesManifestModule(state)).toContain(
      `setClientUrlProjection(${JSON.stringify(REFERENCE_ID)}, `,
    );
    expect(canRefreshRuntimeDiscovery(state, true)).toBe(true);
    // Cloudflare (no main runner) still needs a committed manifest.
    expect(canRefreshRuntimeDiscovery(state, false)).toBe(false);

    await discoverRouters(state, createRscEnv(realms, 0).rscEnv, ssrEnv);
    expect(state.mergedRouteManifest).toEqual(MANIFEST);
    expect(canRefreshRuntimeDiscovery(state, false)).toBe(true);
  });

  it("stays off without a recorded failure when nothing was committed", () => {
    expect(canRefreshRuntimeDiscovery(createState(), true)).toBe(false);
  });
});
