import { describe, it, expect, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. The bake path under test never renders Flight (the handler
// halts before encoding), so a stub is sufficient.
function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { createRouter } from "../../router.js";
import type { RangoInternal } from "../../router/router-interfaces.js";
import { urls } from "../../urls/urls-function.js";
import {
  Static,
  getStaticMounts,
  renderStaticMount,
} from "../../static-handler.js";
import { generateManifestFull } from "../../build/generate-manifest.js";

// Issue #762: bake-time reverse() resolved root-scope through the name-keyed
// GLOBAL registry, and the static collector compounds it two ways:
// (1) it swept the RouterRegistry first-non-null, handing the FIRST router's
// id and route map to every Static handler regardless of ownership; (2) it
// passes `$$routePrefix` — a name PREFIX ("scope"), never present in the
// root-scope registry — so even a router-scoped registry lookup degrades to
// the `!prefix.includes(".")` heuristic. The fix records the definitive values
// for each mount of the Static definition (recordStaticMount: router id,
// route name, root scope) and the collector selects the owning router and
// passes the recorded root scope through.
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
    // (prerender-collection.ts): each recorded mount through
    // renderStaticMount. Pre-fix this shape leaked "/foo": nothing carried the
    // mount's root scope, the prefix-shaped fallback name is never in the
    // root-scope registry, and the lookup fell to the no-dot heuristic.
    const mounts = getStaticMounts(staticDef);
    expect(mounts).toHaveLength(1);
    const [mount] = mounts;
    await renderStaticMount(routerA, staticDef, mount!).catch(() => {});

    expect(resolved).toBeUndefined();
    expect(reverseError).toBeTruthy();

    // The recorded mount: the collector's ownership + scoping inputs.
    expect(mount).toMatchObject({
      routerId: "bake-site",
      routeName: "scope.shared",
      rootScoped: false,
      reverseScope: undefined,
    });
  });
});
