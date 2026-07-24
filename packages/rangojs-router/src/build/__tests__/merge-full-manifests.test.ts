import { describe, expect, it } from "vitest";
import type { FullManifest } from "../generate-manifest.js";
import { mergeFullManifests } from "../merge-full-manifests.js";

describe("mergeFullManifests", () => {
  it("recursively merges ordered mounts with later route metadata winning", () => {
    const first: FullManifest = {
      prefixTree: {
        "/group": {
          staticPrefix: "/group",
          fullPrefix: "/group",
          namePrefix: "group.",
          routes: ["server", "shared"],
          children: {
            "/group/old": {
              staticPrefix: "/group/old",
              fullPrefix: "/group/old",
              routes: ["oldNested"],
              children: {},
            },
          },
        },
      },
      routeManifest: {
        server: "/server",
        shared: "/old-shared",
        oldNested: "/group/old",
      },
      routeTrailingSlash: { server: "never", shared: "always" },
      prerenderRoutes: ["server", "shared"],
      passthroughRoutes: ["server", "shared"],
      responseTypeRoutes: { server: "text", shared: "json" },
      routeSearchSchemas: {
        server: { tab: "string" },
        shared: { old: "string" },
      },
      _prerenderDefs: {
        server: { source: "server" },
        shared: { source: "old" },
      },
    };
    const later: FullManifest = {
      prefixTree: {
        "/group": {
          staticPrefix: "/group",
          fullPrefix: "/group",
          routes: ["client"],
          children: {
            "/group/new": {
              staticPrefix: "/group/new",
              fullPrefix: "/group/new",
              routes: ["newNested"],
              children: {},
            },
          },
        },
        "/replacement": {
          staticPrefix: "/replacement",
          fullPrefix: "/replacement",
          routes: ["shared"],
          children: {},
        },
      },
      routeManifest: {
        client: "/client",
        newNested: "/group/new",
        shared: "/replacement",
      },
      routeTrailingSlash: { client: "always", shared: "never" },
      prerenderRoutes: ["client"],
      passthroughRoutes: ["client"],
      responseTypeRoutes: { shared: "text" },
      routeSearchSchemas: {
        client: { view: "string?" },
        shared: { next: "number" },
      },
      _prerenderDefs: { client: { source: "client" } },
    };
    const firstSnapshot = structuredClone(first);
    const laterSnapshot = structuredClone(later);

    const merged = mergeFullManifests([first, later]);

    expect(merged.routeManifest).toEqual({
      server: "/server",
      shared: "/replacement",
      oldNested: "/group/old",
      client: "/client",
      newNested: "/group/new",
    });
    expect(merged.routeTrailingSlash).toEqual({
      server: "never",
      client: "always",
      shared: "never",
    });
    expect(merged.routeSearchSchemas).toEqual({
      server: { tab: "string" },
      client: { view: "string?" },
      shared: { next: "number" },
    });
    expect(merged.responseTypeRoutes).toEqual({
      server: "text",
      shared: "text",
    });
    expect(merged.prerenderRoutes).toEqual(["server", "client"]);
    expect(merged.passthroughRoutes).toEqual(["server", "client"]);
    expect(merged._prerenderDefs).toEqual({
      server: { source: "server" },
      client: { source: "client" },
    });
    expect(merged.prefixTree["/group"]?.routes).toEqual(["server", "client"]);
    expect(merged.prefixTree["/group"]).not.toHaveProperty("namePrefix");
    expect(Object.keys(merged.prefixTree["/group"]?.children ?? {})).toEqual([
      "/group/old",
      "/group/new",
    ]);
    expect(merged.prefixTree["/replacement"]?.routes).toEqual(["shared"]);
    expect(first).toEqual(firstSnapshot);
    expect(later).toEqual(laterSnapshot);
    expect(merged.prefixTree["/group"]).not.toBe(first.prefixTree["/group"]);
    expect(merged.routeSearchSchemas?.shared).not.toBe(
      later.routeSearchSchemas?.shared,
    );
  });

  it("carries every FullManifest field through a merge (new fields cannot be silently dropped)", () => {
    // `satisfies Required<FullManifest>` is the tripwire: adding a field to
    // GeneratedManifest/FullManifest fails compilation HERE until a value is
    // added — and the assertion below then fails until mergeFullManifests
    // learns to carry it. Without this, a new optional field merges to
    // silently-dropped for every multi-mount router with no type error
    // (merge-full-manifests.ts hand-enumerates its output object).
    const complete = {
      prefixTree: {
        "/a": {
          staticPrefix: "/a",
          fullPrefix: "/a",
          routes: ["a"],
          children: {},
        },
      },
      routeManifest: { a: "/a" },
      routeTrailingSlash: { a: "never" },
      prerenderRoutes: ["a"],
      passthroughRoutes: ["a"],
      responseTypeRoutes: { a: "json" },
      routeSearchSchemas: { a: { q: "string" } },
      _prerenderDefs: { a: { source: "a" } },
    } satisfies Required<FullManifest>;

    const merged = mergeFullManifests([complete, complete]);

    for (const key of Object.keys(complete) as Array<keyof FullManifest>) {
      expect(
        merged[key],
        `mergeFullManifests dropped FullManifest field "${key}"`,
      ).toBeDefined();
    }
  });
});
