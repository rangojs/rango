/**
 * Simulates a consumer augmenting the Rango global namespace, the way a real
 * app does in router.tsx (Env/Vars) and via the generated router.named-routes.gen.ts
 * (GeneratedRouteMap).
 *
 * This file is compiled ONLY by tsconfig.augment-check.json and is excluded from
 * the main program, so the global augmentation here does not leak into the rest
 * of the type tests, which assert the UNAUGMENTED fallbacks
 * (see src/__tests__/augmentation-fallback-types.test.ts).
 */

export interface TestBindings {
  DB: { query: (sql: string) => string };
  SECRET: string;
}

export interface TestVars {
  user?: { id: string; role: "admin" | "user" };
  requestId?: string;
}

/**
 * A userland domain type that controls its own JSON wire shape via `toJSON()`.
 * This is the augmentation hook: `Rango.JsonSerialize` honors `toJSON()`, so a
 * consumer adjusts how their type serializes with no registry API.
 */
export class Money {
  constructor(public cents: number) {}
  toJSON(): number {
    return this.cents;
  }
}

/**
 * Mirrors `typeof router.routeMap`: the same routes as the generated map, plus a
 * response route whose payload carries a userland class (`Money`, with
 * `toJSON()`) and a `Date` — used to assert `Rango.PathResponse` reports the
 * serialized JSON wire shape.
 */
export interface TestRegisteredRoutes {
  readonly home: "/";
  readonly "blog.post": "/blog/:slug";
  readonly search: {
    readonly path: "/search";
    readonly search: { readonly q: "string"; readonly page: "number?" };
  };
  readonly order: {
    readonly path: "/orders/:id";
    readonly response: { id: string; total: Money; placedAt: Date };
  };
}

declare global {
  namespace Rango {
    interface Env extends TestBindings {}
    interface Vars extends TestVars {}
    interface RegisteredRoutes extends TestRegisteredRoutes {}
    // Mirrors the shape emitted into router.named-routes.gen.ts: plain string
    // patterns, plus { path, search } objects for routes with a search schema.
    interface GeneratedRouteMap {
      readonly home: "/";
      readonly "blog.post": "/blog/:slug";
      readonly search: {
        readonly path: "/search";
        readonly search: { readonly q: "string"; readonly page: "number?" };
      };
    }

    // Userland serialization overrides: full-transform replacement that
    // special-cases one type and delegates the rest to the built-in. Isolated to
    // this augment-check program, so the main suite's built-in behavior (e.g.
    // JsonSerialize<bigint> = never) is unaffected — demonstrating overrides are
    // per-project augmentation.
    interface JsonSerializeOverride<T> {
      app: T extends bigint ? string : Rango.JsonSerializeBuiltin<T>;
    }
    interface FlightSerializeOverride<T> {
      app: T extends Money ? number : Rango.FlightSerializeBuiltin<T>;
    }
  }
}
