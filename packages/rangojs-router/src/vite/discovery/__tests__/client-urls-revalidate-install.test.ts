import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateManifestFull } from "../../../build/generate-manifest.js";
import { clientUrls } from "../../../client-urls/client-urls.js";
import {
  clearClientUrlRevalidators,
  registerClientUrlRevalidators,
} from "../../../client-urls/revalidate-registry.js";
import {
  clearClientUrlProjections,
  clientUrlIncludePatterns,
  setClientUrlProjection,
  type ClientUrlProjection,
  type ClientUrlReference,
} from "../../../client-urls/server-projection.js";
import { RouterRegistry } from "../../../router.js";
import { RangoContext } from "../../../server/context.js";
import type { LoaderDefinition, ShouldRevalidateFn } from "../../../types.js";
import { urls } from "../../../urls/urls-function.js";
import { refreshRecordedClientUrlProjections } from "../client-urls-projection.js";
import { discoverRouters } from "../discover-routers.js";
import { createDiscoveryState } from "../state.js";

// Node dev serves requests in the realm discovery installs projections in. A
// request re-evaluates the group's import chain (its `?rango-revalidate`
// module and the files discovery assigned it), then materializes the
// installed projection: a key no file of that chain registers fails it with
// "has no server registration" (a 500).

const ENTRY = "/app/src/router.tsx";
const REFERENCE_ID = "/src/shop.urls.tsx#default";
const GROUP = "/app/src/shop.urls.tsx";
const PAGE = "/app/src/page.tsx";
const ITEM = "/app/src/item.tsx";

function Page(): null {
  return null;
}

const cartLoader: LoaderDefinition<unknown> = {
  __brand: "loader",
  $$id: "loaders#cart",
};

function clientReference(id: string): ClientUrlReference {
  return Object.assign(
    function ClientUrlDefinition(): null {
      return null;
    },
    { $$typeof: Symbol.for("react.client.reference"), $$id: id },
  ) as unknown as ClientUrlReference;
}

function materialize(referenceId: string): void {
  RangoContext.run(
    {
      manifest: new Map(),
      patterns: new Map(),
      trailingSlash: new Map(),
      searchSchemas: new Map(),
      namespace: "test",
      parent: null,
      counters: {},
    },
    () => clientUrlIncludePatterns(clientReference(referenceId)).handler(),
  );
}

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "rango-revalidate-install-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  RouterRegistry.clear();
  clearClientUrlProjections();
  clearClientUrlRevalidators();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("a clientUrls() projection installs after the registrations of every predicate it reads", () => {
  it("serves every request while a .use predicate moves to a module the group did not load, and back", async () => {
    const state = createDiscoveryState(ENTRY, undefined);
    state.projectRoot = projectRoot;
    state.clientUrlSourceByReferenceId = new Map([[REFERENCE_ID, GROUP]]);

    // The file holding the group's one `.use` predicate, and its key.
    let use = { file: PAGE, key: "k-page" };
    const move = (file: string, key: string) => {
      use = { file, key };
    };
    // `<file>?rango-revalidate` evaluates: it registers the file's predicate.
    const evaluateRegistrations = (file: string) => {
      if (file === use.file) {
        registerClientUrlRevalidators({ [use.key]: () => true });
      }
    };

    const failures: string[] = [];
    let step: string | undefined;
    const serverMod = {
      RouterRegistry,
      clearClientUrlProjections,
      setClientUrlProjection(
        referenceId: string,
        projection: ClientUrlProjection,
      ) {
        setClientUrlProjection(referenceId, projection);
        if (step === undefined) return;
        // A request served right after the install.
        for (const file of state.clientUrlRevalidate.filesByGroup.get(GROUP) ??
          []) {
          evaluateRegistrations(file);
        }
        try {
          materialize(referenceId);
        } catch (error) {
          failures.push(`${step}: ${(error as Error).message}`);
        }
      },
    };
    const rscRunner = {
      import: vi.fn(async (id: string): Promise<unknown> => {
        if (id === "@rangojs/router/server") return serverMod;
        if (id === "@rangojs/router/build") return { generateManifestFull };
        if (id === ENTRY) {
          RouterRegistry.set("app", {
            id: "app",
            urlpatterns: urls(({ include }) => [
              include("/shop", clientReference(REFERENCE_ID) as never, {
                name: "shop",
              }),
            ]),
          } as never);
          return {};
        }
        const file = id.replace(/\?rango-revalidate$/, "");
        if (file !== id) {
          // Register on a later task, as a real module import does, so an
          // install that does not await the registrations fails.
          await new Promise((resolve) => setTimeout(resolve, 0));
          evaluateRegistrations(file);
          return {};
        }
        throw new Error(`unexpected rsc import ${id}`);
      }),
    };
    const rscEnv = { runner: rscRunner };
    const ssrEnv = {
      runner: {
        async import(): Promise<Record<string, unknown>> {
          // The hoist transform records the key's file as the SSR copy loads.
          state.clientUrlRevalidate.fileByKey.set(use.key, use.file);
          return {
            default: clientUrls(({ path, loader, revalidate }) => [
              path("/:id", Page, { name: "item" }, () => [
                loader(cartLoader, () => [
                  revalidate({
                    $$rangoRevalidate: use.key,
                  } as unknown as ShouldRevalidateFn),
                ]),
              ]),
            ]),
          };
        },
      },
    };
    // One HMR cycle: the watcher's pre-refresh, then the re-discovery pass.
    const save = async (label: string) => {
      step = `${label}, watcher pre-refresh`;
      await refreshRecordedClientUrlProjections(
        state,
        ssrEnv,
        serverMod,
        rscEnv,
      );
      step = `${label}, re-discovery`;
      await discoverRouters(state, rscEnv, ssrEnv);
    };

    // Cold start: requests wait for discovery (the routes-manifest gate).
    await discoverRouters(state, rscEnv, ssrEnv);

    move(ITEM, "k-item");
    await save("moved to item.tsx");
    move(ITEM, "k-item-edited");
    await save("edited in item.tsx");
    move(PAGE, "k-page-edited");
    await save("moved back to page.tsx");

    expect(failures).toEqual([]);
    expect(state.clientUrlRevalidate.filesByGroup).toEqual(
      new Map([[GROUP, [PAGE]]]),
    );
  });
});
