import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import {
  buildShellKey,
  resolvePprConfig,
  shellSearchSeed,
} from "../shell-serve.js";
import type { EntryData } from "../../server/context.js";
import { RangoContext } from "../../server/context.js";
import { loadManifest, clearManifestCache } from "../../router/manifest.js";
import { urls } from "../../urls.js";
import type { RouteEntry } from "../../types.js";

// resolvePprConfig policy pins (issues #714 / #715): captureTimeout parsing
// and the nameless-route round-trip. The gate reads ONLY the classified
// manifest entry — a route's NAME never participates, so a nameless path()'s
// synthesized-$path_* entry must resolve identically to a named one.

function routeEntry(ppr: unknown): EntryData {
  return { type: "route", ppr } as unknown as EntryData;
}

describe("resolvePprConfig — captureTimeout parsing (issue #715)", () => {
  it("passes a finite positive number through", () => {
    expect(resolvePprConfig(routeEntry({ captureTimeout: 10000 }))).toEqual({
      ttl: 300,
      swr: undefined,
      tags: undefined,
      captureTimeout: 10000,
    });
  });

  it("clamps values above the tightening-only default", () => {
    expect(
      resolvePprConfig(routeEntry({ captureTimeout: 60_000 }))?.captureTimeout,
    ).toBe(15_000);
  });

  it("keeps ttl/swr/tags alongside captureTimeout", () => {
    expect(
      resolvePprConfig(
        routeEntry({ ttl: 60, swr: 120, tags: ["a"], captureTimeout: 8500 }),
      ),
    ).toEqual({ ttl: 60, swr: 120, tags: ["a"], captureTimeout: 8500 });
  });

  it("ppr: true resolves with NO captureTimeout (capture default owns it)", () => {
    expect(resolvePprConfig(routeEntry(true))).toEqual({ ttl: 300 });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["sub-1ms", 0.5],
    ["a string", "9000"],
    ["null", null],
  ])(
    "normalizes %s to undefined (falls back to the capture default)",
    (_label, value) => {
      const resolved = resolvePprConfig(routeEntry({ captureTimeout: value }));
      expect(resolved).not.toBeNull();
      expect(resolved!.captureTimeout).toBeUndefined();
    },
  );

  it("still returns null for undeclared / false ppr", () => {
    expect(
      resolvePprConfig({ type: "route" } as unknown as EntryData),
    ).toBeNull();
    expect(resolvePprConfig(routeEntry(false))).toBeNull();
  });
});

describe("nameless path() keeps ppr on its manifest entry (issue #714)", () => {
  beforeEach(() => {
    clearManifestCache();
  });

  // The full DSL round-trip: a NAMELESS path() registers its EntryData under
  // the synthesized `$path_*` manifest key with the `ppr` option intact, and
  // the serve gate's resolvePprConfig resolves it — name is orthogonal to
  // shell caching. This is the mechanical pin for the issue's fix bar
  // ("nameless ppr WORKS"); the e2e in both apps pins the MISS -> HIT lane.
  it("loadManifest resolves the $path_* entry with ppr (+ captureTimeout) intact", async () => {
    const patterns = urls(({ path }) => [
      path("/test/:id", () => createElement("div"), {
        ppr: { ttl: 300, swr: 86400, captureTimeout: 9000 },
      }),
    ]);
    // "/test/:id".replace(/[/:*?]/g, "_") -> "$path__test__id" (path-helper.ts).
    const routeKey = "$path__test__id";
    const entry = {
      prefix: "/",
      staticPrefix: "/",
      routes: { [routeKey]: "/test/:id" },
      handler: patterns.handler,
      mountIndex: 0,
    } as unknown as RouteEntry;

    await RangoContext.run(
      {
        manifest: new Map(),
        namespace: "",
        parent: null,
        counters: {},
        patterns: new Map(),
        patternsByPrefix: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
      } as never,
      async () => {
        const manifestEntry = await loadManifest(
          entry,
          routeKey,
          "/test/123",
          undefined,
          true,
        );
        expect(manifestEntry.type).toBe("route");
        expect((manifestEntry as { ppr?: unknown }).ppr).toEqual({
          ttl: 300,
          swr: 86400,
          captureTimeout: 9000,
        });
        expect(resolvePprConfig(manifestEntry)).toEqual({
          ttl: 300,
          swr: 86400,
          tags: undefined,
          captureTimeout: 9000,
        });
      },
    );
  });
});

describe("shellSearchSeed — the key's search portion IS the render seed", () => {
  it("sorts params and prefixes with ? (empty search seeds empty)", () => {
    const url = new URL("https://shop.example/products?b=2&a=1");
    expect(shellSearchSeed(url)).toBe("?a=1&b=2");
    expect(shellSearchSeed(new URL("https://shop.example/products"))).toBe("");
  });

  it("buildShellKey embeds exactly the seed, so key and render can never disagree", () => {
    const url = new URL("https://shop.example/products?b=2&a=1");
    expect(buildShellKey(url)).toBe(
      `shop.example/products${shellSearchSeed(url)}:shell`,
    );
  });
});
