// @vitest-environment happy-dom
/**
 * The browser's params-scoped prefetch entries (rango-t242): an answer the
 * server labelled `x-rsc-prefetch-scope: params; <label>` is stored under the
 * label and adopted by every page whose own label under the same shape is
 * equal (browser/prefetch/cache.ts, prefetch/fetch.ts prefetchStorageSlot,
 * navigation-client.ts consumeStoredPrefetch).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import {
  buildParamsKey,
  buildPrefetchKey,
  buildSourceKey,
  clearPrefetchCache,
  consumePrefetch,
  currentGeneration,
  currentPrefetchEpoch,
  hasPrefetch,
  initPrefetchCache,
  pageMatchesParamsLabel,
  paramsCandidateKeys,
  rememberParamsShape,
  storePrefetch,
  type DecodedPrefetch,
} from "../browser/prefetch/cache.js";
import { prefetchStorageSlot } from "../browser/prefetch/fetch.js";
import { consumeStoredPrefetch } from "../browser/navigation-client.js";
import { invalidateClientCache } from "../browser/invalidate-client-cache.js";
import {
  committedPageOf,
  getCommittedPage,
  registerCommittedPageReader,
} from "../browser/navigation-store-handle.js";
import { createEventController } from "../browser/event-controller.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../browser/react/context.js";
import { useParams } from "../browser/react/use-params.js";
import { ClientUrlsRoot } from "../client-urls/client-root.js";
import { clientUrls } from "../client-urls/client-urls.js";
import {
  beginClientUrlNavigation,
  clearClientUrlNavigationRegistry,
} from "../client-urls/navigation.js";
import {
  formatSourceLabel,
  parseSourceShape,
  type SourcePage,
} from "../prefetch-source-scope.js";

const STATE = "s1";
const TARGET = new URL("http://localhost/en?_rsc_partial=true");

const page = (
  params: Record<string, string | undefined>,
  routeName?: string,
): SourcePage => ({ params, routeName });

const entry = (label?: string): DecodedPrefetch => ({
  payload: Promise.resolve({ metadata: { label } } as never),
  streamComplete: Promise.resolve(),
  scope: label === undefined ? "wildcard" : "params",
  ...(label !== undefined && { paramsLabel: label }),
  epoch: currentPrefetchEpoch(),
  complete: true,
});

/** Store an answer the server labelled `label`, as fetch.ts does. */
function storeLabelled(label: string, target: URL = TARGET): string {
  const slot = prefetchStorageSlot(
    false,
    `params; ${label}`,
    buildSourceKey(STATE, "http://localhost/src", target),
    buildPrefetchKey(STATE, target),
    STATE,
    target,
  );
  storePrefetch(slot.key, entry(label), currentGeneration());
  rememberParamsShape(target, slot.paramsLabel!);
  return slot.key;
}

/** The entry a click from `from` adopts, by its label. */
function adopt(from: SourcePage, target: URL = TARGET): string | null {
  const { entry: hit } = consumeStoredPrefetch(
    true,
    buildSourceKey(STATE, "http://localhost/other", target),
    paramsCandidateKeys(STATE, target, from),
    buildPrefetchKey(STATE, target),
  );
  return hit ? (hit.paramsLabel ?? "shared") : null;
}

const EN = "$k=locale,page&locale=en";

afterEach(() => {
  clearPrefetchCache(false);
  initPrefetchCache(300_000, 100);
});

describe("a params-scoped prefetch, stored then looked up", () => {
  it("from a page with the same values of what the rule read: hit", () => {
    storeLabelled(EN);
    expect(adopt(page({ locale: "en", page: "2" }))).toBe(EN);
  });

  it("from a page with a different value: miss", () => {
    storeLabelled(EN);
    expect(adopt(page({ locale: "fr", page: "1" }))).toBeNull();
  });

  it("from a page missing a param of the key set: miss", () => {
    storeLabelled(EN);
    expect(adopt(page({ locale: "en" }))).toBeNull();
  });

  it("from a page with an extra param: miss (the key set is part of the group)", () => {
    storeLabelled(EN);
    expect(adopt(page({ locale: "en", page: "1", id: "3" }))).toBeNull();
  });

  it("grouped by route name: a page of the same route hits, another route misses", () => {
    storeLabelled("$r=shop.product");
    expect(adopt(page({ id: "1" }, "shop.product"))).toBe("$r=shop.product");
    storeLabelled("$r=shop.product");
    expect(adopt(page({ id: "1" }, "shop.cart"))).toBeNull();
  });

  it("before boot (no committed page): no params-scoped candidate", () => {
    storeLabelled(EN);
    expect(paramsCandidateKeys(STATE, TARGET, null)).toEqual([]);
  });
});

describe("several shapes stored for one target", () => {
  it("are tried with the most names first", () => {
    storeLabelled("$k=locale,page&locale=en");
    storeLabelled("$k=locale,page&locale=en&page=1");
    const keys = paramsCandidateKeys(
      STATE,
      TARGET,
      page({ locale: "en", page: "1" }),
    );
    expect(keys).toEqual([
      buildParamsKey(STATE, "$k=locale,page&locale=en&page=1", TARGET),
      buildParamsKey(STATE, "$k=locale,page&locale=en", TARGET),
    ]);
  });

  it("a page matching only the coarser shape adopts that one", () => {
    storeLabelled("$k=locale,page&locale=en");
    storeLabelled("$k=locale,page&locale=en&page=1");
    expect(adopt(page({ locale: "en", page: "2" }))).toBe(
      "$k=locale,page&locale=en",
    );
  });
});

describe("precedence of the three scopes", () => {
  it("page-only first, then grouped, then shared", () => {
    const sourceKey = buildSourceKey(STATE, "http://localhost/src", TARGET);
    const wildcardKey = buildPrefetchKey(STATE, TARGET);
    storePrefetch(wildcardKey, entry(), currentGeneration());
    storeLabelled(EN);
    const onPage = page({ locale: "en", page: "1" });
    const lookup = () =>
      consumeStoredPrefetch(
        true,
        sourceKey,
        paramsCandidateKeys(STATE, TARGET, onPage),
        wildcardKey,
      );
    storePrefetch(sourceKey, entry("$source"), currentGeneration());
    expect(lookup().hitKey).toBe(sourceKey);
    clearPrefetchCache(false);
    storePrefetch(wildcardKey, entry(), currentGeneration());
    storeLabelled(EN);
    expect(lookup().hitKey).toBe(buildParamsKey(STATE, EN, TARGET));
    clearPrefetchCache(false);
    storePrefetch(wildcardKey, entry(), currentGeneration());
    expect(lookup().hitKey).toBe(wildcardKey);
  });

  it("a response with no scope header is stored as shared", () => {
    const slot = prefetchStorageSlot(
      false,
      null,
      "src",
      buildPrefetchKey(STATE, TARGET),
      STATE,
      TARGET,
    );
    expect(slot).toEqual({
      scope: "wildcard",
      key: buildPrefetchKey(STATE, TARGET),
    });
  });

  it("x-rsc-prefetch-scope: source is stored page-only, and a forced :source wins over a params header", () => {
    expect(
      prefetchStorageSlot(false, "source", "src", "w", STATE, TARGET).scope,
    ).toBe("source");
    expect(
      prefetchStorageSlot(true, `params; ${EN}`, "src", "w", STATE, TARGET),
    ).toEqual({ scope: "source", key: "src" });
  });
});

describe("invalidation and eviction", () => {
  it("a rotated rango state misses every params-scoped entry stored under the old one", () => {
    storeLabelled(EN);
    const keys = paramsCandidateKeys(
      "s2",
      TARGET,
      page({ locale: "en", page: "1" }),
    );
    expect(keys.some(hasPrefetch)).toBe(false);
  });

  it("clearPrefetchCache clears the entries and the shape index", () => {
    const key = storeLabelled(EN);
    clearPrefetchCache(false);
    expect(hasPrefetch(key)).toBe(false);
    expect(
      paramsCandidateKeys(STATE, TARGET, page({ locale: "en", page: "1" })),
    ).toEqual([]);
  });

  it("invalidateClientCache clears the entries and the shape index", () => {
    const key = storeLabelled(EN);
    invalidateClientCache();
    expect(hasPrefetch(key)).toBe(false);
    expect(
      paramsCandidateKeys(STATE, TARGET, page({ locale: "en", page: "1" })),
    ).toEqual([]);
  });

  it("FIFO eviction of a params entry leaves the index consistent: the lookup misses, a new store hits", () => {
    initPrefetchCache(300_000, 2);
    storeLabelled(EN);
    storePrefetch("other-1", entry(), currentGeneration());
    storePrefetch("other-2", entry(), currentGeneration());
    const onPage = page({ locale: "en", page: "2" });
    expect(adopt(onPage)).toBeNull();
    storeLabelled(EN);
    expect(adopt(onPage)).toBe(EN);
  });

  it("the shape index is bounded by the cache size, oldest target first", () => {
    initPrefetchCache(300_000, 2);
    const targets = ["/a", "/b", "/c"].map(
      (path) => new URL(`http://localhost${path}?_rsc_partial=true`),
    );
    for (const target of targets) storeLabelled(EN, target);
    const onPage = page({ locale: "en", page: "1" });
    expect(paramsCandidateKeys(STATE, targets[0]!, onPage)).toEqual([]);
    expect(paramsCandidateKeys(STATE, targets[2]!, onPage)).toHaveLength(1);
  });
});

describe("the label", () => {
  it("round-trips its shape, values with =, &, ; and unicode included", () => {
    const shape = { keys: true, route: true, names: ["q"] };
    const at = page({ q: "a=b&c;d ü", x: "1" }, "search");
    const label = formatSourceLabel(shape, at);
    expect(parseSourceShape(label)).toEqual(shape);
    expect(pageMatchesParamsLabel(label, at)).toBe(true);
    expect(
      pageMatchesParamsLabel(label, page({ q: "a=b&c;d", x: "1" }, "search")),
    ).toBe(false);
  });

  it("an absent (undefined) value differs from an empty string", () => {
    const label = formatSourceLabel(
      { keys: true, route: false, names: ["region"] },
      page({ region: undefined }),
    );
    expect(label).toBe("$k=region&region");
    expect(pageMatchesParamsLabel(label, page({ region: "" }))).toBe(false);
    expect(pageMatchesParamsLabel(label, page({ region: undefined }))).toBe(
      true,
    );
  });

  it("a param named like a marker ($k, $r) cannot collide with one", () => {
    const label = formatSourceLabel(
      { keys: false, route: false, names: ["$k"] },
      page({ $k: "x" }),
    );
    expect(parseSourceShape(label)).toEqual({
      keys: false,
      route: false,
      names: ["$k"],
    });
  });
});

describe("the committed page the lookup reads", () => {
  afterEach(() => {
    cleanup();
    clearClientUrlNavigationRegistry();
  });

  it("stays the committed page while an optimistic clientUrls() frame presents another locale", async () => {
    const controller = createEventController({
      initialLocation: new URL("http://localhost/en"),
    });
    controller.setParams({ locale: "en" });
    registerCommittedPageReader(
      committedPageOf(controller, {
        getHistoryEntryMemory: () => ({ routeName: "home", state: null }),
      }),
    );
    const Home = () => createElement("p", { "data-testid": "home" }, "home");
    const Products = () =>
      createElement("p", { "data-testid": "products" }, useParams().locale);
    const definition = clientUrls(({ path }) => [
      path("/:locale", Home),
      path("/:locale/products", Products),
    ]);
    const result = render(
      createElement(
        NavigationStoreContext.Provider,
        {
          value: {
            eventController: controller,
          } as unknown as NavigationStoreContextValue,
        },
        createElement(ClientUrlsRoot, {
          definition,
          routeId: "client-route-0",
        }),
      ),
    );
    expect(result.getByTestId("home")).toBeDefined();

    await act(async () => {
      beginClientUrlNavigation(
        new URL("http://localhost/fr/products"),
        new AbortController().signal,
      );
    });
    // The frame is presented: the destination reads its own params.
    expect(result.getByTestId("products").textContent).toBe("fr");
    // The lookup a click made now reads the page that is committed.
    expect(getCommittedPage()).toEqual({
      params: { locale: "en" },
      routeName: "home",
    });
  });
});
