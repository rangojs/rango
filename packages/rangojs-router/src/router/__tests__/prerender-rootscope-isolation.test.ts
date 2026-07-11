import { describe, it, expect, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. The bake path under test never renders Flight (the handler
// halts before encoding), so a stub is sufficient.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  createFromReadableStream: vi.fn(),
  renderToReadableStream: vi.fn(),
  loadServerAction: vi.fn(),
  decodeReply: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
  createTemporaryReferenceSet: vi.fn(),
}));

import { createRouter } from "../../router.js";
import type { RangoInternal } from "../../router/router-interfaces.js";
import { urls } from "../../urls/urls-function.js";
import { Static } from "../../static-handler.js";
import { generateManifestFull } from "../../build/generate-manifest.js";

// Issue #762: bake-time reverse() resolved root-scope through the name-keyed
// GLOBAL registry, and the static collector compounds it two ways:
// (1) it swept the RouterRegistry first-non-null, handing the FIRST router's
// id and route map to every Static handler regardless of ownership; (2) it
// passes `$$routePrefix` — a name PREFIX ("scope"), never present in the
// root-scope registry — so even a router-scoped registry lookup degrades to
// the `!prefix.includes(".")` heuristic. The fix stamps the definitive values
// on the Static definition at mount time (stampStaticDefScope: $$routerId,
// $$routeName, $$rootScoped) and the collector selects the owning router and
// passes the stamped root-scope through.
let resolved: string | undefined;
let reverseError: unknown;

const staticDef = Static(async (ctx: any) => {
  // Non-root-scoped route: ".foo" has no scoped match ("scope.foo" does not
  // exist) and bare-name fallback is NOT allowed — this must throw. Router
  // B's root-scoped flag (or the dot-heuristic on a prefix-shaped name)
  // wrongly resolves "/foo".
  try {
    resolved = ctx.reverse(".foo");
  } catch (e) {
    reverseError = e;
  }
  // Halt before Flight encoding — the assertions are about reverse().
  throw new Error("halt-before-encode");
});

const scoped = urls(({ path }) => [
  path("/shared", staticDef, { name: "shared" }),
]);

// Router A: "scope.shared" sits under a NAMED include — NOT root-scoped.
const patternsA = urls(({ path, include }) => [
  path("/foo", () => null, { name: "foo" }),
  include("/sub", scoped, { name: "scope" }),
]);
const routerA = createRouter({ id: "bake-site" }).routes(
  patternsA,
) as unknown as RangoInternal<any, any>;

// Router B declares the SAME name at top level (root-scoped) and evaluates
// LAST, so the global registry's entry for "scope.shared" says root-scoped.
const patternsB = urls(({ path }) => [
  path("/scope/shared", () => null, { name: "scope.shared" }),
]);
createRouter({ id: "bake-admin" }).routes(patternsB);

describe("bake-time root-scope isolation (issue #762)", () => {
  it("stamps scope identity on the Static def and bakes with the owning router's root-scope", async () => {
    // Mirror discovery: include children evaluate lazily, so router A's
    // "scope.shared" (and the def stamps) land during manifest generation
    // (routerId threaded — #757), not at createRouter(). B evaluates last, so
    // the GLOBAL registry holds B's root-scoped flag for the shared name.
    await generateManifestFull(patternsA, 0, { routerId: "bake-site" });
    await generateManifestFull(patternsB, 1, { routerId: "bake-admin" });

    // Replicate the collector's EXACT production call on the OWNING router
    // (prerender-collection.ts): full route name with the prefix fallback,
    // and the def-stamped root-scope. Pre-fix this shape leaked "/foo": the
    // stamps did not exist, the prefix-shaped fallback name is never in the
    // root-scope registry, and the lookup fell to the no-dot heuristic.
    const def = staticDef as any;
    await routerA
      .renderStaticSegment(
        def.handler,
        def.$$id,
        def.$$routeName ?? def.$$routePrefix,
        undefined,
        undefined,
        def.$$rootScoped,
      )
      .catch(() => {});

    expect(resolved).toBeUndefined();
    expect(reverseError).toBeTruthy();

    // Mount-time stamps: the collector's ownership + scoping inputs.
    expect(def.$$routerId).toBe("bake-site");
    expect(def.$$routeName).toBe("scope.shared");
    expect(def.$$rootScoped).toBe(false);
    expect(def.$$routePrefix).toBe("scope");
  });
});
