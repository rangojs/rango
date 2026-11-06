/**
 * A Static() layout or parallel slot bakes `ctx.reverse(".name")` in the
 * include scope it was mounted in, exactly as the same layout resolves it
 * live — at every nesting depth, the root included.
 *
 * The bake collector (prerender-collection.ts) renders defs outside any
 * evaluation scope, so the def carries its mount scope
 * (stampStaticDefScope: `$$reverseScope` for a layout/parallel mount,
 * `$$routeName` for a path mount) and renderStaticSegment bakes with it
 * (withReverseScope). Before, the collector passed the def's name PREFIX as a
 * route name; resolveRouteName drops a route name's last segment, so a layout
 * two includes deep resolved one module too high (/acme/settings instead of
 * /acme/web/settings) and a root-level layout threw "Unknown route".
 */
import { beforeAll, describe, it, expect, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. The bake path under test halts before rendering Flight.
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
import { Static } from "../../static-handler.js";
import { generateManifestFull } from "../../build/generate-manifest.js";

/** One `ctx.reverse()` call a baked handler makes: its URL, or its error. */
interface Reversed {
  value?: string;
  error?: Error;
}

/**
 * A Static handler that makes the given reverse() calls and halts before
 * Flight encoding, so the bake reports reverse() itself (same shape as
 * prerender-rootscope-isolation.test.ts).
 */
function staticReverses(calls: Record<string, [string, any?]>): {
  def: any;
  reversed: Record<string, Reversed>;
} {
  const reversed: Record<string, Reversed> = {};
  const def = Static(async (ctx: any) => {
    for (const [key, [name, params]] of Object.entries(calls)) {
      try {
        reversed[key] = { value: ctx.reverse(name, params) };
      } catch (error) {
        reversed[key] = { error: error as Error };
      }
    }
    throw new Error("halt-before-encode");
  });
  return { def, reversed };
}

const ACCOUNT_PARAMS = { accountId: "acme", projectId: "web" };

const rootLayout = staticReverses({ home: [".srHome"] });
const accountLayout = staticReverses({
  settings: [".settings", ACCOUNT_PARAMS],
});
const accountSlot = staticReverses({ settings: [".settings", ACCOUNT_PARAMS] });
const projectLayout = staticReverses({
  settings: [".settings", ACCOUNT_PARAMS],
  // Walks up past its own include to the account module's route.
  billing: [".billing", { accountId: "acme" }],
});
const projectSlot = staticReverses({ settings: [".settings", ACCOUNT_PARAMS] });
const projectPath = staticReverses({ settings: [".settings", ACCOUNT_PARAMS] });

const projectPatterns = urls(({ path, layout, parallel }) => [
  layout(projectLayout.def, () => [
    path("/issues", projectPath.def, { name: "issues" }, () => [
      parallel({ "@aside": projectSlot.def }),
    ]),
    path("/settings", () => null, { name: "settings" }),
  ]),
]);

const accountPatterns = urls(({ path, layout, parallel, include }) => [
  layout(accountLayout.def, () => [
    parallel({ "@aside": accountSlot.def }),
    path("/settings", () => null, { name: "settings" }),
    path("/billing", () => null, { name: "billing" }),
    include("/:projectId", projectPatterns, { name: "project" }),
  ]),
]);

const patterns = urls(({ path, layout, include }) => [
  layout(rootLayout.def, () => [
    path("/", () => null, { name: "srHome" }),
    include("/:accountId", accountPatterns, { name: "srAccount" }),
  ]),
]);

// The Vite transform injects the generated named-routes map (every route,
// lazy include children included) as $$routeNames; discovery's RSC realm sees
// the same complete map when it bakes.
const router = createRouter({
  id: "static-reverse-scope",
  $$routeNames: {
    srHome: "/",
    "srAccount.settings": "/:accountId/settings",
    "srAccount.billing": "/:accountId/billing",
    "srAccount.project.issues": "/:accountId/:projectId/issues",
    "srAccount.project.settings": "/:accountId/:projectId/settings",
  },
}).routes(patterns) as unknown as RangoInternal<any, any>;

/** The collector's production call (prerender-collection.ts). */
async function bake(def: any): Promise<void> {
  await router
    .renderStaticSegment(
      def.handler,
      def.$$id,
      def.$$routeName,
      undefined,
      undefined,
      def.$$rootScoped,
      def.$$reverseScope,
    )
    .catch(() => {});
}

beforeAll(async () => {
  // Discovery evaluates include children while generating the manifest, which
  // is where the defs get their mount stamps.
  await generateManifestFull(patterns, 0, { routerId: "static-reverse-scope" });
  for (const { def } of [
    rootLayout,
    accountLayout,
    accountSlot,
    projectLayout,
    projectSlot,
    projectPath,
  ]) {
    await bake(def);
  }
});

describe("a Static() layout or slot bakes reverse() in its mount scope", () => {
  it("the def carries the mount kind: a layout its scope, a path its route name", () => {
    expect(projectLayout.def.$$routeName).toBeUndefined();
    expect(projectLayout.def.$$reverseScope).toEqual({
      prefix: "srAccount.project",
      rootScoped: false,
    });
    expect(projectPath.def.$$routeName).toBe("srAccount.project.issues");
    expect(projectPath.def.$$reverseScope).toBeUndefined();
  });

  it("a root-level layout resolves a bare name at root scope", () => {
    // Before: no route name and no prefix, so the bake threw
    // Unknown route: ".srHome" and the build failed.
    expect(rootLayout.reversed.home).toEqual({ value: "/" });
  });

  it("one include deep the layout resolves in its module", () => {
    expect(accountLayout.reversed.settings).toEqual({
      value: "/acme/settings",
    });
  });

  it("a nested layout resolves in its own module, not one module up", () => {
    // Before: "srAccount.settings" (/acme/settings), the account's route.
    expect(projectLayout.reversed.settings).toEqual({
      value: "/acme/web/settings",
    });
  });

  it("a nested layout still walks up to an enclosing include's route", () => {
    expect(projectLayout.reversed.billing).toEqual({ value: "/acme/billing" });
  });

  it("a parallel slot resolves like a layout at the same depth", () => {
    // Before: /acme/settings, one module up, like the layout.
    expect(projectSlot.reversed.settings).toEqual({
      value: "/acme/web/settings",
    });
    expect(accountSlot.reversed.settings).toEqual({ value: "/acme/settings" });
  });

  it("a path()-mounted Static keeps resolving from its route name", () => {
    expect(projectPath.reversed.settings).toEqual({
      value: "/acme/web/settings",
    });
  });
});
