import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement } from "react";
import {
  buildShellKey,
  navigationShellKey,
  notePartitionBuildShellCheck,
  partitionBuildShellCheckDone,
  partitionShellKey,
  resetShellServeStateForTests,
  resolvePprConfig,
  shellReloadScript,
  shellSearchSeed,
} from "../shell-serve.js";
import type { EntryData } from "../../server/context.js";
import { RangoContext } from "../../server/context.js";
import { loadManifest, clearManifestCache } from "../../router/manifest.js";
import { urls } from "../../urls.js";
import { clientUrls } from "../../client-urls/client-urls.js";
import { clientUrlIncludePatterns } from "../../client-urls/server-projection.js";
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

  it("keeps on-demand prerender routes off the shell lane", () => {
    expect(
      resolvePprConfig({
        ...routeEntry(true),
        isOnDemand: true,
      } as EntryData),
    ).toBeNull();
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

describe("clientUrls group route keeps ppr on its manifest entry", () => {
  beforeEach(() => {
    clearManifestCache();
  });

  // The group round-trip: a clientUrls() path() with the projected `ppr`
  // option materializes into a server path() whose manifest entry carries
  // ppr — resolvePprConfig classifies the group route exactly like a
  // hand-written ppr page, which is what engages the runtime shell
  // capture/serve lanes for group landings.
  it("materialized group path() carries ppr through loadManifest to resolvePprConfig", async () => {
    function GroupPage() {
      return null;
    }
    const patterns = clientUrlIncludePatterns(
      clientUrls(({ path }) => [
        path("/ppr", GroupPage, { ppr: { ttl: 300, swr: 120 } }),
      ]),
    );
    const routeKey = "$path__ppr";
    const entry = {
      prefix: "/",
      staticPrefix: "/",
      routes: { [routeKey]: "/ppr" },
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
          "/ppr",
          undefined,
          true,
        );
        expect(manifestEntry.type).toBe("route");
        expect((manifestEntry as { ppr?: unknown }).ppr).toEqual({
          ttl: 300,
          swr: 120,
        });
        expect(resolvePprConfig(manifestEntry)).toEqual({
          ttl: 300,
          swr: 120,
          tags: undefined,
          captureTimeout: undefined,
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
    expect(buildShellKey("shop", url)).toBe(
      `shop@shop.example/products${shellSearchSeed(url)}:shell`,
    );
  });
});

// #1065: a hostOverride cookie or a warm under another router's host puts two
// routers on one host and path. Keyed by host and path alone, they shared one
// shell entry.
describe("buildShellKey — a shell belongs to one router", () => {
  const url = new URL("https://preview.dev/shelled");

  it("two routers on one host and path build two keys", () => {
    expect(buildShellKey("app-a", url)).toBe("app-a@preview.dev/shelled:shell");
    expect(buildShellKey("app-b", url)).toBe("app-b@preview.dev/shelled:shell");
  });

  it("the partition and the navigation entry stay under the router's key", () => {
    const key = buildShellKey("app-a", url);
    expect(partitionShellKey(key, "tier:gold")).toBe(
      "app-a@preview.dev/shelled:shell|tier%3Agold",
    );
    expect(navigationShellKey(key)).toBe(
      "app-a@preview.dev/shelled:shell:navigation",
    );
  });

  it("encodes the id: an explicit id cannot name another router's shell", () => {
    // Raw, the id `a@x` on host `y` and the id `a` on host `x@y` would be one
    // string; a host holds no `@`, and neither does an encoded id.
    expect(buildShellKey("a@preview.dev", new URL("https://x/shelled"))).toBe(
      "a%40preview.dev@x/shelled:shell",
    );
  });
});

// hasBuildShell answers per router (the manifest key carries the router), so
// what one router's probe found says nothing about another router's.
describe("partition build-shell probe memo — per router", () => {
  beforeEach(() => {
    resetShellServeStateForTests();
  });

  it("a path one router found without a build shell is still probed for another", () => {
    notePartitionBuildShellCheck("app-a", "/p", "page", false);

    expect(partitionBuildShellCheckDone("app-a", "/p", "page")).toBe(true);
    expect(partitionBuildShellCheckDone("app-b", "/p", "page")).toBe(false);
  });

  it("a route one router warned about still warns for another router's route of that name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      notePartitionBuildShellCheck("app-a", "/p", "page", true);
      expect(partitionBuildShellCheckDone("app-a", "/p", "page")).toBe(true);
      expect(partitionBuildShellCheckDone("app-b", "/p", "page")).toBe(false);

      notePartitionBuildShellCheck("app-b", "/p", "page", true);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

// The degrade's client half (serveShellHit): reload once into a forced MISS.
// Run against a stand-in window, the way a browser runs the inline script.
describe("shellReloadScript", () => {
  function runScript(href: string) {
    const calls: string[] = [];
    const html = shellReloadScript();
    const body = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    const location = {
      href,
      replace: (to: string) => calls.push(`replace ${to}`),
    };
    const window = { stop: () => calls.push("stop") };
    new Function("window", "location", body)(window, location);
    return { calls, html };
  }

  it("stops the half-sent page, then replaces it with the forced-MISS URL", () => {
    const { calls } = runScript("https://shop.test/p?color=blue");
    expect(calls).toEqual([
      "stop",
      "replace https://shop.test/p?color=blue&_rsc_shell=miss",
    ]);
  });

  it("does nothing on a URL that already carries the marker (the loop bound)", () => {
    const { calls } = runScript("https://shop.test/p?_rsc_shell=miss");
    expect(calls).toEqual([]);
  });

  it("the marker never partitions the shell key", () => {
    expect(
      buildShellKey(
        "shop",
        new URL("https://shop.test/p?b=2&_rsc_shell=miss&a=1"),
      ),
    ).toBe(buildShellKey("shop", new URL("https://shop.test/p?a=1&b=2")));
  });
});
