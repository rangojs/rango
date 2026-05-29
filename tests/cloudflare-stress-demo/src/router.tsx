import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";
import type { ResponseEnvelope } from "@rangojs/router/client";
import { urlpatterns } from "./urls.js";
import { Document } from "./document.js";
import type { AppBindings } from "./env.js";

export const router = createRouter<AppBindings>({
  document: Document,
  debugPerformance: true, // Enable Server-Timing headers
  // CF cache store for segment caching
  cache: (_env, ctx) => ({
    store: new CFCacheStore({ ctx: ctx! }),
  }),
  onError: (error) => {
    // Log errors to console (can be extended to use external logging services)
    console.error("Router error:", error);
  },
}).routes(urlpatterns);

// Module-level reverse() calls — resolved via static NamedRoutes fallback
console.log(
  "reverse shop.product.item42:",
  router.reverse("shop.product.item42"),
);
console.log(
  "reverse shop.category.cat42:",
  router.reverse("shop.category.cat42"),
);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

// ---------- Type-level verification ----------
// These assertions verify PathResponse works with response routes in a large route map (10k+ routes).
// Compile errors here mean the type system regressed — do not remove.
// Rango.PathResponse is ambient (no import).

// Response routes resolve their typed response data (wrapped in ResponseEnvelope)
type _HealthResponse = Rango.PathResponse<"/json-api/health">;
type _AssertHealth = _HealthResponse extends
  | { data: { status: "ok"; timestamp: number; uptime: number } }
  | { error: unknown }
  ? true
  : never;
const _checkHealth: _AssertHealth = true;

type _StatsResponse = Rango.PathResponse<"/json-api/stats">;
type _AssertStats = _StatsResponse extends
  | { data: { routes: number; prefixes: number; lazy: boolean } }
  | { error: unknown }
  ? true
  : never;
const _checkStats: _AssertStats = true;

type _ItemResponse = Rango.PathResponse<"/json-api/items/:id">;
type _AssertItem = _ItemResponse extends
  | { data: { id: string; name: string; price: number; inStock: boolean } }
  | { error: unknown }
  ? true
  : never;
const _checkItem: _AssertItem = true;

// Response routes are also valid paths for href()
type _AssertHealthPath = "/json-api/health" extends Rango.Path ? true : never;
const _checkHealthPath: _AssertHealthPath = true;

// Shop routes with template literal params remain valid (conservative filter keeps `${number}`)
type _AssertShopProduct = `/shop/product/${number}` extends Rango.Path
  ? true
  : never;
const _checkShopProduct: _AssertShopProduct = true;

// ---------- Concrete-path response inference (regression coverage) ----------
// Rango.PathResponse accepts a concrete path (a filled-in URL), not just a route
// pattern. These are EXACT-equality assertions so they catch BOTH directions of
// regression: union bleed across routes (widening) and resolving to never
// (narrowing). This is the strongest guard for the path-matching logic, run
// against the 10k+ route map so overlap regressions surface here.
type _Expect<T extends true> = T;
type _Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type HealthPayload = { status: "ok"; timestamp: number; uptime: number };
type ItemListPayload = { id: string; name: string; price: number }[];
type ItemDetailPayload = {
  id: string;
  name: string;
  price: number;
  inStock: boolean;
};

// A concrete dynamic path resolves to the detail payload, identical to its
// pattern lookup — and is NOT widened by the static list route or any of the
// 10k other routes in the map.
type _ConcreteItem = Rango.PathResponse<"/json-api/items/123">;
type _CheckConcreteItem = _Expect<
  _Equal<_ConcreteItem, ResponseEnvelope<ItemDetailPayload>>
>;
type _CheckConcreteEqPattern = _Expect<
  _Equal<_ConcreteItem, Rango.PathResponse<"/json-api/items/:id">>
>;

// The static list route stays exactly its array payload (proves list/detail do
// not bleed in either direction).
type _CheckListExact = _Expect<
  _Equal<
    Rango.PathResponse<"/json-api/items">,
    ResponseEnvelope<ItemListPayload>
  >
>;

// Query/hash suffixes are stripped before matching a concrete path.
type _CheckQuerySuffix = _Expect<
  _Equal<
    Rango.PathResponse<"/json-api/health?ts=1">,
    ResponseEnvelope<HealthPayload>
  >
>;
type _CheckHashSuffix = _Expect<
  _Equal<
    Rango.PathResponse<"/json-api/items/123#top">,
    ResponseEnvelope<ItemDetailPayload>
  >
>;

// An unmatched concrete path resolves to ResponseEnvelope<never>, not a stray
// payload picked up by greedy matching across the large map.
type _CheckUnmatched = _Expect<
  _Equal<
    Rango.PathResponse<"/json-api/does-not-exist">,
    ResponseEnvelope<never>
  >
>;

// Typed-fetch wrapper: the response is inferred from the concrete path argument.
// Declared (no body) so this stays a type-level check with no runtime in the
// router entry.
declare function typedGet<T extends Rango.Path>(
  path: T,
): Promise<Rango.PathResponse<T>>;
type _WrapperItem = Awaited<ReturnType<typeof typedGet<"/json-api/items/7">>>;
type _CheckWrapperItem = _Expect<
  _Equal<_WrapperItem, ResponseEnvelope<ItemDetailPayload>>
>;

// Reference the assertion aliases so they are unambiguously evaluated.
export type _ConcretePathResponseAssertions = [
  _CheckConcreteItem,
  _CheckConcreteEqPattern,
  _CheckListExact,
  _CheckQuerySuffix,
  _CheckHashSuffix,
  _CheckUnmatched,
  _CheckWrapperItem,
];
