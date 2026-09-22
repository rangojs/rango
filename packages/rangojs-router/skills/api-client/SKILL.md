---
name: api-client
description: Build a typed client for consuming your own response-route JSON APIs (no codegen). Use when calling your own JSON endpoints from another service or script, or you want typed fetch calls without a codegen step.
---

# Typed API Client

Use this skill when first-party TypeScript code (a client component, another
worker, a script) calls your own `path.json()` endpoints and you want typed
params and payloads without writing `fetch` + URL building by hand.

Response routes (`path.json()`) already ship typed responses — `RouteResponse<typeof patterns, "name">` resolves to the **bare payload**, inferred from your handler with no codegen. This skill wraps that inference in a small **typed client** so first-party TypeScript code calls your endpoints like functions instead of hand-writing `fetch` + URL building per call site.

This is a **recipe, not a framework feature** — copy the helper below into your app. It depends only on **type-only** imports from `@rangojs/router` (`RouteResponse`, `ExtractParams`, `ProblemDetails`), which are erased at build time, so it runs anywhere a `fetch` does — **browser, worker, or server**. Nothing new to install or version.

> **Scope:** the typed client is a **first-party TypeScript** convenience. External/third-party consumers use the plain wire directly — bare JSON on success, RFC 9457 `application/problem+json` on error — which needs no client. (Language-agnostic OpenAPI generation is a separate, future feature.)

## What you get

```ts
const api = createApiClient<typeof apiShopPatterns, typeof routes>(routes, {
  baseUrl,
});

await api.health.get(); // no params → callable bare
await api.product.get({ params: { productId } }); // params typed + required
await api.cart.post({ body: { productId, qty: 2 } }); // body sent as JSON
//    ^ result is the bare payload type (RouteResponse), not `any`, no `.data`
```

- **Output typed** from the handler's return (`RouteResponse`), zero codegen.
- **Params required + typed** from the route pattern (`/catalog/:productId` → `{ productId: string }`); a missing or misspelled param is a **compile error**, not a runtime 404.
- **Autocomplete** over every route name; rename-safe.
- **Errors throw a typed `ApiError`** carrying the `ProblemDetails` body.

(`search` and `body` are _not_ route-typed — see Notes.)

## The two inputs

1. **The `urls()` patterns type** — the type source, passed as the first type argument. `typeof apiShopPatterns` carries the per-route response payloads and patterns. Only the type is needed, so import it with `import type` (see Notes).
2. **The generated route map** — the name → pattern source, passed as the value argument (and its `typeof` as the second type argument). `rango generate` emits a per-module `<name>.gen.ts` exporting `routes`:

```ts
// api-shop.gen.ts (generated — do not edit)
export const routes = {
  catalog: "/catalog",
  product: "/catalog/:productId",
  cart: "/cart",
  // ...
} as const;
```

Routes that declare a **search schema** are generated as objects instead — `index: { path: "/", search: { q: "string" } }`. The helper accepts both the string and `{ path }` forms.

The per-module map's keys are the block's local route names (matching `RouteResponse`), but its patterns are **mount-relative**: `"/catalog"`, not `"/api/shop/catalog"`. When the block is mounted under a URL prefix, either put the prefix in `baseUrl` (`` `${origin}/api/shop` ``) or build a local-keyed map of absolute patterns from the global `NamedRoutes` in `router.named-routes.gen.ts` (e.g. `{ catalog: NamedRoutes["apiShop.catalog"], ... } as const`).

## The helper (copy into your app)

```ts
// lib/api-client.ts
import type {
  RouteResponse,
  ExtractParams,
  ProblemDetails,
  UrlPatterns,
} from "@rangojs/router";

type SearchParams = Record<string, string | number | boolean>;

// A generated route-map entry is a pattern string, or an object with `path`
// (routes that declare a search schema generate the object form).
type RouteMapEntry = string | { readonly path: string };
type PatternOf<E> = E extends string
  ? E
  : E extends { readonly path: infer P extends string }
    ? P
    : never;

// `params` is optional when the route has no *required* params (incl.
// optional-only routes like `/:locale?`), required otherwise. Typed as
// `ExtractParams` (not `undefined`) so optional params can still be passed.
type Args<TPattern extends string> =
  {} extends ExtractParams<TPattern>
    ? {
        params?: ExtractParams<TPattern>;
        search?: SearchParams;
        body?: unknown;
      }
    : {
        params: ExtractParams<TPattern>;
        search?: SearchParams;
        body?: unknown;
      };

type Method<TPatterns, K extends string, TEntry> =
  {} extends ExtractParams<PatternOf<TEntry>>
    ? (args?: Args<PatternOf<TEntry>>) => Promise<RouteResponse<TPatterns, K>>
    : (args: Args<PatternOf<TEntry>>) => Promise<RouteResponse<TPatterns, K>>;

type ApiClient<TPatterns, TRouteMap extends Record<string, RouteMapEntry>> = {
  [K in keyof TRouteMap & string]: {
    get: Method<TPatterns, K, TRouteMap[K]>;
    post: Method<TPatterns, K, TRouteMap[K]>;
    put: Method<TPatterns, K, TRouteMap[K]>;
    patch: Method<TPatterns, K, TRouteMap[K]>;
    delete: Method<TPatterns, K, TRouteMap[K]>;
  };
};

/** Thrown on a non-2xx response; carries the RFC 9457 problem body. */
export class ApiError extends Error {
  status: number;
  problem: ProblemDetails;
  constructor(status: number, problem: ProblemDetails) {
    super(problem.detail || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

// Client-safe path builder: substitutes :params (incl. optional/constrained
// forms) into the pattern. No dependency on the server-only createReverse.
function fillPath(pattern: string, params?: Record<string, string>): string {
  return pattern
    .replace(/:([A-Za-z0-9_]+)(?:\([^)]*\))?\??/g, (_m, name: string) => {
      const v = params?.[name];
      return v == null ? "" : encodeURIComponent(String(v));
    })
    .replace(/\/{2,}/g, "/");
}

// Both type arguments are explicit: TPatterns has no value to infer from,
// and TypeScript does not mix explicit and inferred type arguments.
export function createApiClient<
  TPatterns extends UrlPatterns<any, any, Record<string, unknown>>,
  TRouteMap extends Record<string, RouteMapEntry>,
>(
  routeMap: TRouteMap,
  opts: { baseUrl?: string; fetch?: typeof fetch } = {},
): ApiClient<TPatterns, TRouteMap> {
  const doFetch = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? "";
  const call =
    (name: string, method: string) =>
    async (args?: {
      params?: Record<string, string>;
      search?: SearchParams;
      body?: unknown;
    }) => {
      const entry = routeMap[name];
      const pattern = typeof entry === "string" ? entry : entry.path;
      let url = baseUrl + fillPath(pattern, args?.params);
      if (args?.search) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(args.search)) {
          if (v != null) qs.append(k, String(v));
        }
        const s = qs.toString();
        if (s) url += (url.includes("?") ? "&" : "?") + s;
      }
      const res = await doFetch(url, {
        method,
        ...(args?.body !== undefined
          ? {
              body: JSON.stringify(args.body),
              headers: { "content-type": "application/json" },
            }
          : {}),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as ProblemDetails;
        throw new ApiError(res.status, problem);
      }
      return res.json();
    };
  return new Proxy({} as any, {
    get: (_t, name: string) => ({
      get: call(name, "GET"),
      post: call(name, "POST"),
      put: call(name, "PUT"),
      patch: call(name, "PATCH"),
      delete: call(name, "DELETE"),
    }),
  }) as ApiClient<TPatterns, TRouteMap>;
}
```

## Using it

```ts
import type { apiShopPatterns } from "./urls/api-shop";
import { routes } from "./urls/api-shop.gen";
import { createApiClient, ApiError } from "./lib/api-client";

const api = createApiClient<typeof apiShopPatterns, typeof routes>(routes, {
  baseUrl: import.meta.env.VITE_API_URL ?? "",
});

try {
  const product = await api.product.get({ params: { productId: "42" } });
  // `product` is the handler's bare return type — e.g. `product.name` is typed.
} catch (err) {
  if (err instanceof ApiError && err.status === 404) {
    console.warn(err.problem.code, err.problem.detail); // typed ProblemDetails
  } else {
    throw err;
  }
}
```

## Notes

- **Client-safe by construction.** The helper imports only **types** from `@rangojs/router` (erased at build) and builds URLs itself by substituting `:params` into the pattern — it does **not** use `createReverse`, which is a server/RSC-only export that throws in the browser. So `createApiClient` works in client components, workers, and on the server alike.
- **Import the `urls()` module with `import type`.** `urls()` only runs on the server: in client code a value import throws when the module loads, and it would pull the route handlers into the client bundle. A type import is erased at build, so the same call works in client components, workers and server code. The generated `*.gen.ts` map has no imports and is safe to import anywhere.
- **Always pass both type arguments.** If you leave them out, `TPatterns` falls back to its constraint and every response is typed `never`, so the first property access on a result is a compile error rather than a silent `any`.
- **Params are route-typed; search and body are not.** Path params come from the route pattern (`ExtractParams`), so they are precise and required. `search` is generically typed (`Record<string, string | number | boolean>`), and `body` is `unknown` (serialized to JSON). Typed request **input** needs a declared schema layer, which is intentionally out of scope here — thread per-route schemas in yourself if you want typed search/body.
- **Verb-agnostic wire.** Rango response routes do not dispatch on HTTP method — `.get`/`.post`/etc. set the request method but hit the same handler (branch on `ctx.request.method` inside it if you need to). Use whichever verb reads best for the operation. Response-route `cache()` only serves and stores GET/HEAD.
- **Path building.** `fillPath` handles standard `:param`, optional `:param?`, and constrained `:param(a|b)` forms. For exotic patterns or strict trailing-slash policies, swap in your own builder (or the router's `reverse` on the server).
- **Want a return-based style instead of throwing?** Branch on `res.ok` yourself: the wire is the bare value on 2xx and `ProblemDetails` on non-2xx (see `/response-routes`). Wrapping the calls in a `{ ok, data } | { ok: false, error }` result type is a small variation on the same helper.
- **Third parties.** The typed client is TypeScript-only and needs your route types. External consumers in any language use the plain wire as-is (bare JSON + problem+json); no client required.

See `/response-routes` for the endpoint side and `/typesafety` for how `RouteResponse` / `PathResponse` inference works.
