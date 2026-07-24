import { describe, expect, it, vi } from "vitest";
import { clientUrls } from "../../../client-urls/client-urls.js";
import { serializeClientUrlPatterns } from "../../../client-urls/server-projection.js";
import { computeProductionHash } from "../../plugins/client-ref-hashing.js";
import {
  discoverClientUrlProjections,
  recordClientUrlsModule,
  refreshRecordedClientUrlProjections,
  resolveClientUrlsSource,
} from "../client-urls-projection.js";
import { createDiscoveryState } from "../state.js";

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

    await refreshRecordedClientUrlProjections(state, { runner }, serverMod);

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

    await refreshRecordedClientUrlProjections(state, { runner }, serverMod);

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
    );

    expect(serverMod.setClientUrlProjection).not.toHaveBeenCalled();
    expect(serverMod.clearClientUrlProjections).not.toHaveBeenCalled();
  });
});

describe("discoverClientUrlProjections", () => {
  it("serializes every reference before atomically installing the new projections", async () => {
    const state = createState();
    const firstReference = "/src/first.urls.tsx#default";
    const secondReference = "/src/second.urls.tsx#default";
    const firstSource = `${PROJECT_ROOT}/src/first.urls.tsx`;
    const secondSource = `${PROJECT_ROOT}/src/second.urls.tsx`;
    state.clientUrlSourceByReferenceId.set(firstReference, firstSource);
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
    const registry = new Map([
      ["first", { __clientUrlReferences: [{ $$id: firstReference }] }],
      ["second", { __clientUrlReferences: [{ $$id: secondReference }] }],
    ]);

    await discoverClientUrlProjections(state, { runner }, serverMod, registry);

    expect(importedSources).toEqual([firstSource, secondSource]);
    expect(serverMod.calls).toEqual([
      "clear",
      `set:${firstReference}`,
      `set:${secondReference}`,
    ]);
    expect(state.clientUrlProjectionMap).not.toBe(previous);
    expect(state.clientUrlProjectionMap).toEqual(
      new Map([
        [firstReference, projection],
        [secondReference, projection],
      ]),
    );
  });

  it("preserves last-known state and makes no registry calls when a later default export is invalid", async () => {
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
    const registry = new Map([
      ["first", { __clientUrlReferences: [{ $$id: firstReference }] }],
      ["second", { __clientUrlReferences: [{ $$id: secondReference }] }],
    ]);

    await expect(
      discoverClientUrlProjections(state, { runner }, serverMod, registry),
    ).rejects.toThrow(
      `reference "${secondReference}" from source "${secondSource}"`,
    );
    expect(state.clientUrlProjectionMap).toBe(previous);
    expect(serverMod.clearClientUrlProjections).not.toHaveBeenCalled();
    expect(serverMod.setClientUrlProjection).not.toHaveBeenCalled();
  });

  it("names the reference and source when the SSR runner is unavailable", async () => {
    const state = createState();
    const reference = "/src/app.urls.tsx#default";
    const source = `${PROJECT_ROOT}/src/app.urls.tsx`;
    state.clientUrlSourceByReferenceId.set(reference, source);
    const previous = new Map([["old#default", projection]]);
    state.clientUrlProjectionMap = previous;
    const serverMod = createServerModule();
    const registry = new Map([
      ["app", { __clientUrlReferences: [{ $$id: reference }] }],
    ]);

    await expect(
      discoverClientUrlProjections(state, undefined, serverMod, registry),
    ).rejects.toThrow(`reference "${reference}" from source "${source}"`);
    expect(state.clientUrlProjectionMap).toBe(previous);
    expect(serverMod.calls).toEqual([]);
  });

  it("wraps source import failures without changing state or the registry", async () => {
    const state = createState();
    const reference = "/src/broken.urls.tsx#default";
    const source = `${PROJECT_ROOT}/src/broken.urls.tsx`;
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
    const registry = new Map([
      ["app", { __clientUrlReferences: [{ $$id: reference }] }],
    ]);

    const failure = await discoverClientUrlProjections(
      state,
      { runner },
      serverMod,
      registry,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ cause: importFailure });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      `reference "${reference}" from source "${source}"`,
    );
    expect(state.clientUrlProjectionMap).toBe(previous);
    expect(serverMod.calls).toEqual([]);
  });

  it("names an unresolved reference without importing or changing state", async () => {
    const state = createState();
    const reference = "/src/missing.urls.tsx#default";
    const previous = new Map([["old#default", projection]]);
    state.clientUrlProjectionMap = previous;
    const runner = { import: vi.fn() };
    const serverMod = createServerModule();
    const registry = new Map([
      ["app", { __clientUrlReferences: [{ $$id: reference }] }],
    ]);

    await expect(
      discoverClientUrlProjections(state, { runner }, serverMod, registry),
    ).rejects.toThrow(`reference "${reference}"`);
    expect(runner.import).not.toHaveBeenCalled();
    expect(state.clientUrlProjectionMap).toBe(previous);
    expect(serverMod.calls).toEqual([]);
  });

  it("clears projections atomically when no router has client URL references", async () => {
    const state = createState();
    const previous = new Map([["old#default", projection]]);
    state.clientUrlProjectionMap = previous;
    const serverMod = createServerModule();

    await discoverClientUrlProjections(
      state,
      undefined,
      serverMod,
      new Map([["app", {}]]),
    );

    expect(state.clientUrlProjectionMap).not.toBe(previous);
    expect(state.clientUrlProjectionMap).toEqual(new Map());
    expect(serverMod.calls).toEqual(["clear"]);
    expect(serverMod.setClientUrlProjection).not.toHaveBeenCalled();
  });
});
