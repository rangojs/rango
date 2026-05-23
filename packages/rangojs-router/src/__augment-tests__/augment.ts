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

declare global {
  namespace Rango {
    interface Env extends TestBindings {}
    interface Vars extends TestVars {}
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
  }
}
