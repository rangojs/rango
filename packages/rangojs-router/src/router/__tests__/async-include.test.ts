import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { urls } from "../../urls.js";
import type { RouteEntry } from "../../types.js";
import type { EntryData } from "../../server/context.js";
import { evaluateLazyEntry } from "../lazy-includes.js";
import { createFindMatch } from "../find-match.js";
import { resolveIncludeModule } from "../../urls/include-provider.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { getRouterPrecomputedEntries } from "../../route-map-builder.js";

// Proves async `include(prefix, () => import("./routes"))` end to end via the
// same functions the router calls: evaluateLazyEntry (match-time runtime) and
// buildRouterTrieFromUrlpatterns (build/dev discovery). createRouter() can't be
// imported in unit tests (it pulls a `virtual:` module — see lazy-include-perf).

const Page = createElement("div");

function makeSyntheticRoot(mountIndex = 0): EntryData {
  return {
    type: "layout",
    id: `#synthetic-maproot-M${mountIndex}`,
    shortCode: `M${mountIndex}L0`,
    parent: null,
    handler: Page,
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

function lazyEntry(
  staticPrefix: string,
  name: string,
  lazyPatterns: unknown,
): RouteEntry & { _lazyPrefix?: string } {
  return {
    prefix: "",
    staticPrefix,
    routes: {},
    handler: Page,
    mountIndex: 0,
    lazy: true,
    lazyEvaluated: false,
    lazyPatterns,
    _lazyPrefix: staticPrefix,
    lazyContext: {
      urlPrefix: "",
      namePrefix: name,
      parent: makeSyntheticRoot(),
      counters: {},
    },
  } as unknown as RouteEntry & { _lazyPrefix?: string };
}

function depsFor(entry: RouteEntry) {
  return {
    routesEntries: [entry],
    mergedRouteMap: {} as Record<string, string>,
    nextMountIndex: () => 100,
    getPrecomputedByPrefix: () => null,
  };
}

describe("async include() — () => import() route modules", () => {
  // Runtime: a `() => import()` provider is NOT evaluated until the prefix is
  // matched (the cold-start win), resolved once on first match, then cached.
  it("defers the provider until first match, resolves once, caches", async () => {
    let built = 0;
    const groupPatterns = urls<any>(({ path }) => {
      built++;
      return [path("/widget", Page, { name: "widget" })];
    });
    // Mirrors `() => import("./group")` whose module does `export default urls()`.
    const provider = vi.fn(async () => ({ default: groupPatterns }));
    const entry = lazyEntry("/group", "group", provider);
    const deps = depsFor(entry);

    // Deferred: the module is not built at definition/registration time.
    expect(provider).not.toHaveBeenCalled();
    expect(built).toBe(0);

    // First match into the prefix resolves the provider (async) and expands it.
    const pending = evaluateLazyEntry(entry, deps);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(provider).toHaveBeenCalledTimes(1);
    expect(built).toBe(1);
    expect(entry.routes).toHaveProperty("group.widget");
    expect((entry.routes as Record<string, string>)["group.widget"]).toBe(
      "/group/widget",
    );

    // Re-match: already evaluated → synchronous no-op, provider not re-called.
    const again = evaluateLazyEntry(entry, deps);
    expect(again).toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  // Concurrency: two simultaneous first-hits share one in-flight import+expansion.
  it("dedupes concurrent first-hits (imports + expands exactly once)", async () => {
    const groupPatterns = urls<any>(({ path }) => [
      path("/x", Page, { name: "x" }),
    ]);
    const provider = vi.fn(async () => {
      await Promise.resolve();
      return { default: groupPatterns };
    });
    const entry = lazyEntry("/g", "g", provider);
    const deps = depsFor(entry);

    const a = evaluateLazyEntry(entry, deps);
    const b = evaluateLazyEntry(entry, deps);
    await Promise.all([a, b]);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(entry.routes).toHaveProperty("g.x");
  });

  // The eager path is unchanged: a plain `urls()` value still expands synchronously
  // (returns void, no Promise) so the per-entry match loop pays no microtask.
  it("keeps the eager include path synchronous (no Promise)", () => {
    const groupPatterns = urls<any>(({ path }) => [
      path("/y", Page, { name: "y" }),
    ]);
    const entry = lazyEntry("/e", "e", groupPatterns);
    const result = evaluateLazyEntry(entry, depsFor(entry));
    expect(result).toBeUndefined();
    expect(entry.routes).toHaveProperty("e.y");
  });

  // Discovery: build/dev discovery awaits the provider so the split route group's
  // names land in the manifest + precomputed entries — href() and typed routes
  // survive code-splitting.
  it("discovery resolves async-include routes into the manifest (href/types)", async () => {
    const groupPatterns = urls<any>(({ path }) => [
      path("/leaf", Page, { name: "leaf" }),
    ]);
    const top = urls<any>(({ path, include }) => [
      path("/", Page, { name: "home" }),
      include("/group", () => Promise.resolve({ default: groupPatterns }), {
        name: "group",
      }),
    ]);

    await buildRouterTrieFromUrlpatterns({
      id: "async-include-disc",
      urlpatterns: top,
      basename: undefined,
    });

    const precomputed = getRouterPrecomputedEntries("async-include-disc");
    expect(precomputed).toBeDefined();
    const groupEntry = precomputed!.find((e) => e.staticPrefix === "/group");
    expect(groupEntry).toBeDefined();
    expect(groupEntry!.routes).toHaveProperty("group.leaf");
  });

  // Error recovery: a provider that fails on the first hit (rejected import)
  // must leave the entry retriable — lazyEvaluated stays false and the inflight
  // guard clears — so a later request re-imports and succeeds.
  it("retries the import after a rejected provider (entry stays retriable)", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const groupPatterns = urls<any>(({ path }) => [
      path("/w", Page, { name: "w" }),
    ]);
    let calls = 0;
    const provider = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("import failed");
      return { default: groupPatterns };
    });
    const entry = lazyEntry("/g", "g", provider);
    const deps = depsFor(entry);

    // First hit rejects; the entry must NOT be marked evaluated.
    await expect(evaluateLazyEntry(entry, deps)).rejects.toThrow(
      "import failed",
    );
    expect(entry.lazyEvaluated).toBe(false);
    await tick(); // let work.then(clear) reset the inflight guard

    // Second hit retries the import and succeeds.
    const again = evaluateLazyEntry(entry, deps);
    expect(again).toBeInstanceOf(Promise);
    await again;
    expect(provider).toHaveBeenCalledTimes(2);
    expect(entry.lazyEvaluated).toBe(true);
    expect(entry.routes).toHaveProperty("g.w");
  });

  // AF1: the resolved patterns' handler throwing mid-expansion must not mark the
  // entry evaluated — runExpansion sets lazyEvaluated at the END, after the
  // handler + splice succeed. Set up-front, a broken handler would wedge the
  // route at 404 forever with no retry.
  it("leaves the entry retriable when the resolved handler throws mid-expansion", async () => {
    const throwingPatterns = urls<any>(() => {
      throw new Error("handler boom");
    });
    const provider = vi.fn(async () => ({ default: throwingPatterns }));
    const entry = lazyEntry("/g", "g", provider);

    await expect(evaluateLazyEntry(entry, depsFor(entry))).rejects.toThrow(
      "handler boom",
    );
    expect(entry.lazyEvaluated).toBe(false);
  });
});

// PR review: migrating an include from eager to async must not quietly
// downgrade failure loudness. Build/dev discovery hard-fails; per-request match
// keeps owner failures loud (5xx) while isolating genuinely-unmatched paths.
describe("async include() — error-loudness policy", () => {
  it("hard-fails discovery when an async include provider throws — no silent green build (finding 1)", async () => {
    // Discovery (build + dev trie-rebuild) evaluates providers to build the
    // trie/types; a broken module here must abort, not ship a green build with
    // the group silently absent. (Runtime lazy eval is unaffected — this is the
    // discovery path, which always evaluates to know every route.)
    const patterns = urls(({ include, path }) => [
      path("/ok", Page, { name: "ok" }),
      include("/broken", () => {
        throw new Error("bad transitive import");
      }),
    ]);
    const router = { id: "r-hardfail", urlpatterns: patterns, basename: "" };
    await expect(
      buildRouterTrieFromUrlpatterns(router as unknown as never),
    ).rejects.toThrow(/bad transitive import|Failed to resolve include/);
  });

  it("regex fallback isolates a failing lazy include for an UNMATCHED path — 404 (null), not 500 (finding 4)", async () => {
    const failing = lazyEntry("/", "root", null);
    const findMatch = createFindMatch({
      routerId: "r-finding4-isolate",
      routesEntries: [failing],
      // No trie registered for this routerId -> trieMatched is false, so this
      // pathname is genuinely unmatched. A failing root include must not upgrade
      // its 404 to a 500 just because probing it threw.
      evaluateLazyEntry: () => {
        throw new Error("root include module failed to import");
      },
    });
    await expect(findMatch("/definitely/not/a/route")).resolves.toBeNull();
  });

  it("resolveIncludeModule prefers `default` over a named `handler` export (finding 5)", () => {
    const patterns = urls(({ path }) => [path("/x", Page, { name: "x" })]);
    // A routes module can carry a named `export function handler` alongside its
    // `export default urls(...)`; duck-typing the namespace first would misread
    // the whole module as the urls() value and 404 the group.
    const moduleNamespace = {
      default: patterns,
      handler: () => "user helper, not the DSL handler",
    };
    expect(resolveIncludeModule(moduleNamespace as never)).toBe(patterns);
    // A bare urls() value (no module) still resolves via the mod-as-value branch.
    expect(resolveIncludeModule(patterns as never)).toBe(patterns);
  });
});
