import { describe, expect, it, vi } from "vitest";
import { clientUrls } from "../../../client-urls/client-urls.js";
import {
  serializeClientUrlPatterns,
  type ClientUrlProjection,
} from "../../../client-urls/server-projection.js";
import { computeProductionHash } from "../../plugins/client-ref-hashing.js";
import {
  assignClientUrlRevalidateFiles,
  discoverClientUrlProjections,
  isClientUrlsComponentUseSource,
  recordClientUrlsModule,
  refreshRecordedClientUrlProjections,
  resolveClientUrlsSource,
} from "../client-urls-projection.js";
import { createDiscoveryState } from "../state.js";
import type { LoaderDefinition } from "../../../types.js";

const PROJECT_ROOT = "/workspace/app";

function HomePage() {
  return null;
}

function createState() {
  const state = createDiscoveryState(undefined, undefined);
  state.projectRoot = PROJECT_ROOT;
  return state;
}

function createServerModule() {
  const calls: string[] = [];
  return {
    calls,
    clearClientUrlProjections: vi.fn(() => calls.push("clear")),
    setClientUrlProjection: vi.fn((referenceId: string) =>
      calls.push(`set:${referenceId}`),
    ),
  };
}

const patterns = clientUrls(({ path }) => [path("/", HomePage)]);
const projection = serializeClientUrlPatterns(patterns);
/** discovery's RSC environment: the registration imports. */
const rscEnv = { runner: { import: vi.fn(async (_id: string) => ({})) } };

describe("isClientUrlsComponentUseSource", () => {
  const CLIENT = 'import { loader } from "@rangojs/router/client";\n';

  it("matches a module importing @rangojs/router/client that assigns a .use", () => {
    expect(
      isClientUrlsComponentUseSource(
        `${CLIENT}export function Page() {}\nPage.use = () => [loader(L)];\n`,
      ),
    ).toBe(true);
    expect(
      isClientUrlsComponentUseSource(
        `"use client";\n${CLIENT}Page.use=() => [];\n`,
      ),
    ).toBe(true);
  });

  it("does not match without the client entry, a .use only in a comment or string, or a comparison", () => {
    expect(
      isClientUrlsComponentUseSource(
        'import { loader } from "./dsl";\nPage.use = () => [];\n',
      ),
    ).toBe(false);
    expect(
      isClientUrlsComponentUseSource(`${CLIENT}// Page.use = () => []\n`),
    ).toBe(false);
    expect(
      isClientUrlsComponentUseSource(`${CLIENT}const s = "Page.use = x";\n`),
    ).toBe(false);
    expect(
      isClientUrlsComponentUseSource(`${CLIENT}if (Page.use == null) {}\n`),
    ).toBe(false);
  });
});

describe("recordClientUrlsModule", () => {
  it("resolves development and production default-export references to a queryless absolute source", () => {
    const state = createState();
    const source = `${PROJECT_ROOT}/src/app.urls.tsx`;
    const devReference = "/src/app.urls.tsx#default";
    const productionReference = `${computeProductionHash(
      PROJECT_ROOT,
      "/src/app.urls.tsx",
    )}#default`;

    recordClientUrlsModule(
      state,
      `
        // license
        "use strict";
        "use client";
        import { clientUrls } from "@rangojs/router/client";
        export default clientUrls(() => []);
      `,
      `${source}?v=123`,
    );

    expect(resolveClientUrlsSource(state, devReference)).toBe(source);
    expect(
      resolveClientUrlsSource(state, "/src/app.urls.tsx?t=456#default"),
    ).toBe(source);
    expect(resolveClientUrlsSource(state, productionReference)).toBe(source);
  });

  it.each([
    {
      name: "non-prologue directive",
      code: `const before = true; "use client"; export default clientUrls(() => []);`,
    },
    {
      name: "missing clientUrls call",
      code: `"use client"; export default {};`,
    },
    {
      name: "missing default export",
      code: `"use client"; export const routes = clientUrls(() => []);`,
    },
  ])("ignores a $name module", ({ code }) => {
    const state = createState();
    recordClientUrlsModule(state, code, `${PROJECT_ROOT}/src/ignored.tsx`);
    expect(state.clientUrlSourceByReferenceId).toEqual(new Map());
  });
});

describe("refreshRecordedClientUrlProjections", () => {
  it("imports each source once and syncs the registry AND the state map for every reference id", async () => {
    const state = createState();
    const devReference = "/src/app.urls.tsx#default";
    const hashedReference = "de51dfbf1706#default";
    const source = `${PROJECT_ROOT}/src/app.urls.tsx`;
    state.clientUrlSourceByReferenceId.set(devReference, source);
    state.clientUrlSourceByReferenceId.set(hashedReference, source);
    // Stale entry that a routes-manifest replay would otherwise re-install
    // (scar: node HMR clobbered the fresh registry with these literals).
    state.clientUrlProjectionMap.set(devReference, {
      version: 1,
      routes: [],
    });

    const runner = {
      import: vi.fn(async () => ({ default: patterns })),
    };
    const serverMod = createServerModule();

    await refreshRecordedClientUrlProjections(
      state,
      { runner },
      serverMod,
      rscEnv,
    );

    expect(runner.import).toHaveBeenCalledOnce();
    expect(runner.import).toHaveBeenCalledWith(source);
    expect(serverMod.calls).toEqual([
      `set:${devReference}`,
      `set:${hashedReference}`,
    ]);
    expect(state.clientUrlProjectionMap.get(devReference)).toEqual(projection);
    expect(state.clientUrlProjectionMap.get(hashedReference)).toEqual(
      projection,
    );
  });

  it("keeps last-known state for a failing or non-clientUrls source without throwing", async () => {
    const state = createState();
    const brokenReference = "/src/broken.urls.tsx#default";
    const invalidReference = "/src/invalid.urls.tsx#default";
    const okReference = "/src/ok.urls.tsx#default";
    const brokenSource = `${PROJECT_ROOT}/src/broken.urls.tsx`;
    const invalidSource = `${PROJECT_ROOT}/src/invalid.urls.tsx`;
    const okSource = `${PROJECT_ROOT}/src/ok.urls.tsx`;
    state.clientUrlSourceByReferenceId.set(brokenReference, brokenSource);
    state.clientUrlSourceByReferenceId.set(invalidReference, invalidSource);
    state.clientUrlSourceByReferenceId.set(okReference, okSource);

    const runner = {
      import: vi.fn(async (source: string) => {
        if (source === brokenSource) throw new Error("mid-edit syntax error");
        if (source === invalidSource) return { default: {} };
        return { default: patterns };
      }),
    };
    const serverMod = createServerModule();

    await refreshRecordedClientUrlProjections(
      state,
      { runner },
      serverMod,
      rscEnv,
    );

    expect(serverMod.calls).toEqual([`set:${okReference}`]);
    expect(state.clientUrlProjectionMap.has(brokenReference)).toBe(false);
    expect(state.clientUrlProjectionMap.get(okReference)).toEqual(projection);
  });

  it("no-ops without recorded modules or without an SSR runner", async () => {
    const emptyState = createState();
    const serverMod = createServerModule();
    await refreshRecordedClientUrlProjections(
      emptyState,
      { runner: { import: vi.fn() } },
      serverMod,
      rscEnv,
    );

    const recordedState = createState();
    recordedState.clientUrlSourceByReferenceId.set(
      "/src/app.urls.tsx#default",
      `${PROJECT_ROOT}/src/app.urls.tsx`,
    );
    await refreshRecordedClientUrlProjections(
      recordedState,
      undefined,
      serverMod,
      rscEnv,
    );

    expect(serverMod.setClientUrlProjection).not.toHaveBeenCalled();
    expect(serverMod.clearClientUrlProjections).not.toHaveBeenCalled();
  });
});

describe("discoverClientUrlProjections", () => {
  it("serializes every recorded source once before atomically installing projections", async () => {
    const state = createState();
    const devReference = "/src/first.urls.tsx#default";
    const hashedReference = "abc123#default";
    const secondReference = "/src/second.urls.tsx#default";
    const firstSource = `${PROJECT_ROOT}/src/first.urls.tsx`;
    const secondSource = `${PROJECT_ROOT}/src/second.urls.tsx`;
    state.clientUrlSourceByReferenceId.set(devReference, firstSource);
    state.clientUrlSourceByReferenceId.set(hashedReference, firstSource);
    state.clientUrlSourceByReferenceId.set(secondReference, secondSource);
    const previous = new Map([["old#default", projection]]);
    state.clientUrlProjectionMap = previous;

    const importedSources: string[] = [];
    const runner = {
      import: vi.fn(async (source: string) => {
        importedSources.push(source);
        return { default: patterns };
      }),
    };
    const serverMod = createServerModule();

    await discoverClientUrlProjections(state, { runner }, serverMod, rscEnv);

    // One import per SOURCE; the projection installs under every reference id.
    expect(importedSources).toEqual([firstSource, secondSource]);
    expect(serverMod.calls).toEqual([
      "clear",
      `set:${devReference}`,
      `set:${hashedReference}`,
      `set:${secondReference}`,
    ]);
    expect(state.clientUrlProjectionMap).not.toBe(previous);
    expect(state.clientUrlProjectionMap).toEqual(
      new Map([
        [devReference, projection],
        [hashedReference, projection],
        [secondReference, projection],
      ]),
    );
  });

  it("preserves last-known state and makes no registry calls when a default export is invalid", async () => {
    const state = createState();
    const firstReference = "/src/first.urls.tsx#default";
    const secondReference = "/src/broken.urls.tsx#default";
    const firstSource = `${PROJECT_ROOT}/src/first.urls.tsx`;
    const secondSource = `${PROJECT_ROOT}/src/broken.urls.tsx`;
    state.clientUrlSourceByReferenceId.set(firstReference, firstSource);
    state.clientUrlSourceByReferenceId.set(secondReference, secondSource);
    const previous = new Map([["old#default", projection]]);
    state.clientUrlProjectionMap = previous;

    const runner = {
      import: vi.fn(async (source: string) =>
        source === firstSource
          ? { default: patterns }
          : { default: { __brand: "not-client-urls" } },
      ),
    };
    const serverMod = createServerModule();

    await expect(
      discoverClientUrlProjections(state, { runner }, serverMod, rscEnv),
    ).rejects.toThrow(
      `reference "${secondReference}" from source "${secondSource}"`,
    );
    expect(state.clientUrlProjectionMap).toBe(previous);
    expect(serverMod.clearClientUrlProjections).not.toHaveBeenCalled();
    expect(serverMod.setClientUrlProjection).not.toHaveBeenCalled();
  });

  it("names the reference and source file when a revalidate() predicate was not hoisted", async () => {
    const state = createState();
    const reference = "/src/cart.urls.tsx#default";
    const source = `${PROJECT_ROOT}/src/cart.urls.tsx`;
    state.clientUrlSourceByReferenceId.set(reference, source);
    const previous = new Map([["old#default", projection]]);
    state.clientUrlProjectionMap = previous;
    const cartLoader: LoaderDefinition<unknown> = {
      __brand: "loader",
      $$id: "loaders#cart",
    };
    const unhoisted = clientUrls(({ path, loader, revalidate }) => [
      path("/cart", HomePage, () => [
        loader(cartLoader, () => [revalidate(() => false)]),
      ]),
    ]);
    const runner = { import: vi.fn(async () => ({ default: unhoisted })) };
    const serverMod = createServerModule();

    const failure = await discoverClientUrlProjections(
      state,
      { runner },
      serverMod,
      rscEnv,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(
      `reference "${reference}" from source "${source}"`,
    );
    expect(message).toContain(
      'revalidate() on loader "loaders#cart" of route "/cart" was not hoisted',
    );
    expect(state.clientUrlProjectionMap).toBe(previous);
    expect(serverMod.calls).toEqual([]);
  });

  it("names the reference and source when the SSR runner is unavailable", async () => {
    const state = createState();
    const reference = "/src/app.urls.tsx#default";
    const source = `${PROJECT_ROOT}/src/app.urls.tsx`;
    state.clientUrlSourceByReferenceId.set(reference, source);
    const previous = new Map([["old#default", projection]]);
    state.clientUrlProjectionMap = previous;
    const serverMod = createServerModule();

    await expect(
      discoverClientUrlProjections(state, undefined, serverMod, rscEnv),
    ).rejects.toThrow(`reference "${reference}" from source "${source}"`);
    expect(state.clientUrlProjectionMap).toBe(previous);
    expect(serverMod.calls).toEqual([]);
  });

  it("wraps import failures for a source that still exists on disk", async () => {
    const state = createState();
    // Use THIS test file as the source so existsSync() is true and the
    // failure is treated as a real breakage, not a deleted module.
    const source = new URL(import.meta.url).pathname;
    const reference = "/src/broken.urls.tsx#default";
    state.clientUrlSourceByReferenceId.set(reference, source);
    const previous = new Map([["old#default", projection]]);
    state.clientUrlProjectionMap = previous;
    const importFailure = new Error("compile failed");
    const runner = {
      import: vi.fn(async () => {
        throw importFailure;
      }),
    };
    const serverMod = createServerModule();

    const failure = await discoverClientUrlProjections(
      state,
      { runner },
      serverMod,
      rscEnv,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ cause: importFailure });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      `reference "${reference}" from source "${source}"`,
    );
    expect(state.clientUrlProjectionMap).toBe(previous);
    expect(serverMod.calls).toEqual([]);
  });

  it("drops records for a deleted source instead of failing discovery forever", async () => {
    const state = createState();
    const goneReference = "/src/deleted.urls.tsx#default";
    const goneHashed = "gone123#default";
    const keptReference = "/src/kept.urls.tsx#default";
    const goneSource = `${PROJECT_ROOT}/src/deleted.urls.tsx`;
    const keptSource = `${PROJECT_ROOT}/src/kept.urls.tsx`;
    state.clientUrlSourceByReferenceId.set(goneReference, goneSource);
    state.clientUrlSourceByReferenceId.set(goneHashed, goneSource);
    state.clientUrlSourceByReferenceId.set(keptReference, keptSource);

    const runner = {
      import: vi.fn(async (source: string) => {
        if (source === goneSource) throw new Error("ENOENT");
        return { default: patterns };
      }),
    };
    const serverMod = createServerModule();

    await discoverClientUrlProjections(state, { runner }, serverMod, rscEnv);

    // recordClientUrlsModule never un-records; deletion self-heals here.
    expect(state.clientUrlSourceByReferenceId).toEqual(
      new Map([[keptReference, keptSource]]),
    );
    expect(serverMod.calls).toEqual(["clear", `set:${keptReference}`]);
    expect(state.clientUrlProjectionMap).toEqual(
      new Map([[keptReference, projection]]),
    );
  });

  it("clears projections atomically when nothing is recorded", async () => {
    const state = createState();
    const previous = new Map([["old#default", projection]]);
    state.clientUrlProjectionMap = previous;
    const serverMod = createServerModule();

    await discoverClientUrlProjections(state, undefined, serverMod, rscEnv);

    expect(state.clientUrlProjectionMap).not.toBe(previous);
    expect(state.clientUrlProjectionMap).toEqual(new Map());
    expect(serverMod.calls).toEqual(["clear"]);
    expect(serverMod.setClientUrlProjection).not.toHaveBeenCalled();
  });
});

describe("assignClientUrlRevalidateFiles", () => {
  const groupA = "/app/src/a.urls.tsx";
  const groupB = "/app/src/b.urls.tsx";
  const groupC = "/app/src/c.urls.tsx";
  const fileA = "/app/src/A.tsx";
  const fileB = "/app/src/B.tsx";
  const id = (file: string) => `${file}?rango-revalidate`;
  const route = (
    loaderRevalidate?: (string | boolean)[][],
  ): ClientUrlProjection["routes"][number] => ({
    id: "r",
    pattern: "/",
    name: null,
    options: {},
    loaderIds: [],
    hasLoading: false,
    ...(loaderRevalidate ? { loaderRevalidate } : {}),
  });

  function setup() {
    const state = createDiscoveryState(undefined, undefined);
    // Group A under its dev and production reference ids.
    state.clientUrlSourceByReferenceId = new Map([
      ["/src/a.urls.tsx#default", groupA],
      ["abc123#default", groupA],
      ["/src/b.urls.tsx#default", groupB],
      ["/src/c.urls.tsx#default", groupC],
    ]);
    const a: ClientUrlProjection = {
      version: 1,
      routes: [route([["k1", true], ["k2"]]), route()],
      intercepts: [
        {
          slotName: "@modal",
          targetName: "item",
          loaderIds: [],
          hasLoading: false,
          loaderRevalidate: [["k3"]],
        },
      ],
    };
    const b: ClientUrlProjection = {
      version: 1,
      routes: [route([["k2", "k-unrecorded"]])],
    };
    // Group C reads its own predicates only.
    const c: ClientUrlProjection = { version: 1, routes: [route([["k4"]])] };
    state.clientUrlProjectionMap = new Map([
      ["/src/a.urls.tsx#default", a],
      ["abc123#default", a],
      ["/src/b.urls.tsx#default", b],
      ["/src/c.urls.tsx#default", c],
    ]);
    state.clientUrlRevalidate.fileByKey
      .set("k1", fileA)
      .set("k2", fileB)
      .set("k3", groupA)
      .set("k4", groupC);
    const nodes = new Map(
      [groupA, groupB, groupC].map((group) => [id(group), { id: id(group) }]),
    );
    const rscEnv = {
      runner: { import: vi.fn(async (_id: string) => ({})) },
      moduleGraph: {
        getModuleById: vi.fn((moduleId: string) => nodes.get(moduleId)),
        invalidateModule: vi.fn(),
      },
    };
    const assign = () =>
      assignClientUrlRevalidateFiles(
        state,
        rscEnv as unknown as Parameters<
          typeof assignClientUrlRevalidateFiles
        >[1],
        state.clientUrlProjectionMap!,
      );
    return { state, rscEnv, nodes, assign };
  }

  it("assigns each group the other files of its projection's keys and loads their registrations once", async () => {
    const { state, rscEnv, assign } = setup();
    await assign();
    // k3 is group A's own: its proxy loads it. k-unrecorded has no file:
    // materialization names it.
    expect(state.clientUrlRevalidate.filesByGroup).toEqual(
      new Map([
        [groupA, [fileA, fileB]],
        [groupB, [fileB]],
        [groupC, []],
      ]),
    );
    expect(
      rscEnv.runner.import.mock.calls.map(([moduleId]) => moduleId),
    ).toEqual([id(fileA), id(fileB)]);
  });

  it("invalidates a group's module when its files change, and only then", async () => {
    const { state, rscEnv, nodes, assign } = setup();
    const { invalidateModule } = rscEnv.moduleGraph;
    await assign();
    expect(invalidateModule.mock.calls).toEqual([
      [nodes.get(id(groupA))],
      [nodes.get(id(groupB))],
    ]);

    invalidateModule.mockClear();
    await assign();
    expect(invalidateModule).not.toHaveBeenCalled();

    state.clientUrlRevalidate.fileByKey.set("k-unrecorded", fileA);
    await assign();
    expect(invalidateModule.mock.calls).toEqual([[nodes.get(id(groupB))]]);
    expect(state.clientUrlRevalidate.filesByGroup.get(groupB)).toEqual([
      fileA,
      fileB,
    ]);
  });

  it("drops a group discovery no longer projects", async () => {
    const { state, assign } = setup();
    await assign();
    state.clientUrlProjectionMap!.delete("/src/b.urls.tsx#default");
    await assign();
    expect([...state.clientUrlRevalidate.filesByGroup.keys()]).toEqual([
      groupA,
      groupC,
    ]);
  });
  it("installs nothing when a registration fails to load: the refresh keeps last-known state, the strict pass rejects", async () => {
    const state = createState();
    const reference = "/src/cart.urls.tsx#default";
    state.clientUrlSourceByReferenceId.set(
      reference,
      `${PROJECT_ROOT}/src/cart.urls.tsx`,
    );
    const previous = new Map([[reference, projection]]);
    state.clientUrlProjectionMap = previous;
    state.clientUrlRevalidate.fileByKey.set(
      "k-cart",
      `${PROJECT_ROOT}/src/Cart.tsx`,
    );
    const cartLoader: LoaderDefinition<unknown> = {
      __brand: "loader",
      $$id: "loaders#cart",
    };
    const cart = clientUrls(({ path, loader, revalidate }) => [
      path("/cart", HomePage, () => [
        loader(cartLoader, () => [
          revalidate({ $$rangoRevalidate: "k-cart" } as never),
        ]),
      ]),
    ]);
    const ssrEnv = {
      runner: { import: vi.fn(async () => ({ default: cart })) },
    };
    const failing = {
      runner: {
        import: vi.fn(async () => {
          throw new Error("registration failed to load");
        }),
      },
    };
    const serverMod = createServerModule();

    await refreshRecordedClientUrlProjections(
      state,
      ssrEnv,
      serverMod,
      failing,
    );
    await expect(
      discoverClientUrlProjections(state, ssrEnv, serverMod, failing),
    ).rejects.toThrow("registration failed to load");

    expect(failing.runner.import).toHaveBeenCalledWith(
      `${PROJECT_ROOT}/src/Cart.tsx?rango-revalidate`,
    );
    expect(serverMod.calls).toEqual([]);
    expect(state.clientUrlProjectionMap).toBe(previous);
    expect(state.clientUrlRevalidate.filesByGroup).toEqual(new Map());
  });
});
