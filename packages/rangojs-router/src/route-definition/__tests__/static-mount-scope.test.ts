/**
 * A Static() definition carries one artifact key per (definition, mount scope).
 *
 * The build stores one baked artifact per key and the runtime looks the entry's
 * key up, so a definition mounted in two include() scopes must stamp a different
 * key at each position — the artifact resolves `.name` in that mount's scope,
 * exactly as the live handler does in dev. Keyed by the definition's `$$id`
 * alone, both mounts read the artifact the LAST mount baked.
 *
 * The bake collector's half of the contract is pinned in
 * router/__tests__/static-reverse-scope.rsc-test.tsx.
 */
import { describe, it, expect } from "vitest";
import {
  RangoContext,
  runWithPrefixes,
  type EntryData,
} from "../../server/context.js";
import { urls } from "../../urls/urls-function.js";
import { Static, type StaticHandlerDefinition } from "../../static-handler.js";
import type { StaticMount } from "../../static-handler.js";
import type { UrlPatterns } from "../../urls/pattern-types.js";

/** A fresh definition per test: mount records accumulate on the definition. */
function staticDef(id: string): StaticHandlerDefinition {
  return Static((_ctx) => null, undefined, id) as StaticHandlerDefinition;
}

/** A parent entry shaped enough for the DSL helpers to attach to. */
function parentEntry(): EntryData {
  return {
    id: "test",
    shortCode: "L0",
    type: "layout",
    parent: null,
    handler: null,
    loading: undefined,
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
  } as unknown as EntryData;
}

interface Evaluated {
  /** Layouts and parallels the DSL attached to the root entry. */
  root: EntryData;
  /** Route name -> entry, as path() registers them. */
  manifest: Map<string, EntryData>;
}

/**
 * Evaluate `patterns` once under the router store, optionally inside one named
 * include scope: the URL and name prefixes runWithPrefixes sets are the ones
 * include() would set for its children.
 */
function evaluate(
  patterns: UrlPatterns,
  include?: { url: string; name: string },
): Evaluated {
  const root = parentEntry();
  const manifest = new Map<string, EntryData>();
  RangoContext.run(
    {
      manifest,
      patterns: new Map(),
      patternsByPrefix: new Map(),
      namespace: "test",
      parent: root,
      counters: {},
      routerId: "mount-router",
    } as never,
    () => {
      const run = () => {
        patterns.handler();
      };
      if (include) runWithPrefixes(include.url, include.name, run);
      else run();
    },
  );
  return { root, manifest };
}

function mountsOf(def: StaticHandlerDefinition): StaticMount[] {
  return def.$$staticMounts ?? [];
}

const mountA = { url: "/mount-a", name: "mountA" };
const mountB = { url: "/mount-b", name: "mountB" };

describe("Static() mount scope", () => {
  it("a layout mounted in two include scopes stamps one artifact key per scope", () => {
    const SharedNav = staticDef("test#SharedNav");
    const patterns = urls(({ layout }) => [layout(SharedNav, () => [])]);

    const a = evaluate(patterns, mountA);
    const b = evaluate(patterns, mountB);

    const keyA = (a.root.layout[0] as { staticHandlerId: string })
      .staticHandlerId;
    const keyB = (b.root.layout[0] as { staticHandlerId: string })
      .staticHandlerId;
    expect(keyA).toBe("test#SharedNav::mount-router::mountA");
    expect(keyB).toBe("test#SharedNav::mount-router::mountB");
    expect(mountsOf(SharedNav)).toEqual([
      {
        key: keyA,
        routeName: "mountA",
        rootScoped: false,
        routerId: "mount-router",
      },
      {
        key: keyB,
        routeName: "mountB",
        rootScoped: false,
        routerId: "mount-router",
      },
    ]);
  });

  it("mounting the same definition twice in one scope shares one artifact", () => {
    const SharedNav = staticDef("test#SharedNav");
    const patterns = urls(({ layout }) => [layout(SharedNav, () => [])]);
    const root = parentEntry();
    RangoContext.run(
      {
        manifest: new Map(),
        patterns: new Map(),
        namespace: "test",
        parent: root,
        counters: {},
        routerId: "mount-router",
      } as never,
      () => {
        runWithPrefixes(mountA.url, mountA.name, () => patterns.handler());
        runWithPrefixes(mountA.url, mountA.name, () => patterns.handler());
      },
    );

    const [first, second] = root.layout as Array<{ staticHandlerId: string }>;
    expect(first!.staticHandlerId).toBe(second!.staticHandlerId);
    // One bake for both mounts: the artifact depends on the scope only.
    expect(mountsOf(SharedNav).map((mount) => mount.key)).toEqual([
      first!.staticHandlerId,
    ]);
  });

  it("a parallel slot stamps its own mount key, per scope", () => {
    const SharedAside = staticDef("test#SharedAside");
    const patterns = urls(({ parallel }) => [
      parallel({ "@aside": SharedAside }),
    ]);

    const a = evaluate(patterns, mountA);
    const b = evaluate(patterns, mountB);

    const slotKey = (evaluated: Evaluated) =>
      (
        evaluated.root.parallel["@aside"] as unknown as {
          staticHandlerIds?: Record<string, string>;
        }
      ).staticHandlerIds?.["@aside"];
    expect(slotKey(a)).toBe("test#SharedAside::mount-router::mountA");
    expect(slotKey(b)).toBe("test#SharedAside::mount-router::mountB");
  });

  it("a path() mount keys on its full route name, not the include prefix", () => {
    const SharedNav = staticDef("test#SharedNav");
    const patterns = urls(({ path }) => [
      path("/settings", SharedNav, { name: "settings" }),
    ]);

    const { manifest } = evaluate(patterns, mountA);

    const entry = manifest.get("mountA.settings") as unknown as {
      staticHandlerId: string;
    };
    expect(entry.staticHandlerId).toBe(
      "test#SharedNav::mount-router::mountA.settings",
    );
    expect(mountsOf(SharedNav)).toEqual([
      {
        key: entry.staticHandlerId,
        routeName: "mountA.settings",
        rootScoped: false,
        routerId: "mount-router",
      },
    ]);
  });

  it("a mount at root scope keys apart from a named-include mount", () => {
    const SharedNav = staticDef("test#SharedNav");
    const patterns = urls(({ layout }) => [layout(SharedNav, () => [])]);

    const atRoot = evaluate(patterns);
    const inInclude = evaluate(patterns, mountA);

    expect(
      (atRoot.root.layout[0] as { staticHandlerId: string }).staticHandlerId,
    ).toBe("test#SharedNav::mount-router::");
    expect(
      (inInclude.root.layout[0] as { staticHandlerId: string }).staticHandlerId,
    ).toBe("test#SharedNav::mount-router::mountA");
  });
});
