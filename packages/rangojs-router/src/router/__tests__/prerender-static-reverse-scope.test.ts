import { beforeAll, describe, expect, it, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. The bake path under test never renders Flight (each handler
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
import { Static } from "../../static-handler.js";
import { generateManifestFull } from "../../build/generate-manifest.js";

/**
 * A Static() layout or parallel slot bakes `ctx.reverse(".name")` in the module
 * that declares it, exactly as the same segment renders live.
 *
 * The bake path hands the collector a def outside any evaluation scope, so the
 * def carries the DSL position's include scope (`$$reverseScope`, stamped by
 * stampStaticDefScope). A layout or slot resolves dot names in it
 * (withReverseScope's live rule); a path() Static is a route and keeps the live
 * route ctx's resolution from its own route name.
 *
 * Before: the collector passed the def's `$$routePrefix` as a route NAME, and
 * resolveRouteName strips a route name's last segment — so the project module's
 * layout baked the account module's `/acme/settings`, and a root-level layout
 * (no prefix) threw `Unknown route` for `.home`.
 */
const resolved: Record<string, string | undefined> = {};
const reverseErrors: Record<string, unknown> = {};

function staticReverse(key: string, name: string) {
  return Static((ctx: any) => {
    try {
      resolved[key] = ctx.reverse(name);
    } catch (error) {
      reverseErrors[key] = error;
    }
    // Halt before Flight encoding — the assertion is about reverse().
    throw new Error("halt-before-encode");
  });
}

// Root level: no named include above, so no name prefix.
const rootLayout = staticReverse("root-layout", ".home");
// account module: include("/acme", ..., { name: "account" }).
const accountLayout = staticReverse("account-layout", ".settings");
// project module nested in account: prefix "account.project".
const projectLayout = staticReverse("project-layout", ".settings");
// Parallel slot declared in the project module.
const projectSlot = staticReverse("project-slot", ".settings");
// A path() Static in the account module: a route, not a structural segment.
const accountPage = staticReverse("account-page", ".settings");

const projectPatterns = urls(({ path, layout, parallel }) => [
  layout(projectLayout, () => [
    path("/settings", () => null, { name: "settings" }),
    path(
      "/issues",
      () => null,
      { name: "issues" },
      () => [parallel({ "@badge": projectSlot })],
    ),
  ]),
]);

const accountPatterns = urls(({ path, layout, include }) => [
  layout(accountLayout, () => [
    path("/settings", () => null, { name: "settings" }),
    path("/page", accountPage, { name: "page" }),
    include("/web", projectPatterns, { name: "project" }),
  ]),
]);

const patterns = urls(({ path, layout, include }) => [
  layout(rootLayout, () => [
    path("/", () => null, { name: "home" }),
    include("/acme", accountPatterns, { name: "account" }),
  ]),
]);

const router = createRouter({
  id: "static-reverse-scope",
  // The generated named-routes seed ($$routeNames, injected by the Vite
  // plugin) is where a build's reverse map gets the include routes: they are
  // lazy at runtime, so createRouter() alone does not know them.
  $$routeNames: {
    home: "/",
    "account.settings": "/acme/settings",
    "account.page": "/acme/page",
    "account.project.settings": "/acme/web/settings",
    "account.project.issues": "/acme/web/issues",
  },
}).routes(patterns) as unknown as RangoInternal<any, any>;

/** The collector's bake call (prerender-collection.ts renderStaticHandlers). */
async function bake(def: any): Promise<void> {
  await router
    .renderStaticSegment(
      def.handler,
      def.$$id,
      def.$$routeName,
      undefined,
      undefined,
      def.$$reverseScope,
    )
    .catch(() => {});
}

describe("Static() bake: ctx.reverse('.name') resolves in the declaring module", () => {
  beforeAll(async () => {
    await generateManifestFull(patterns, 0, {
      routerId: "static-reverse-scope",
    });
    for (const def of [
      rootLayout,
      accountLayout,
      projectLayout,
      projectSlot,
      accountPage,
    ]) {
      await bake(def);
    }
  });

  it("a nested module's layout resolves in its own module", () => {
    // The project module's own "settings", not the account module's.
    expect(reverseErrors["project-layout"]).toBeUndefined();
    expect(resolved["project-layout"]).toBe("/acme/web/settings");
  });

  it("a parallel slot declared in a nested module resolves in that module", () => {
    expect(reverseErrors["project-slot"]).toBeUndefined();
    expect(resolved["project-slot"]).toBe("/acme/web/settings");
  });

  it("a layout one include level deep resolves in its module", () => {
    expect(reverseErrors["account-layout"]).toBeUndefined();
    expect(resolved["account-layout"]).toBe("/acme/settings");
  });

  it("a root-level layout resolves dot names at root scope", () => {
    // Before: no prefix meant no scope, so the bake threw Unknown route.
    expect(reverseErrors["root-layout"]).toBeUndefined();
    expect(resolved["root-layout"]).toBe("/");
  });

  it("a path() Static keeps the live route ctx's resolution", () => {
    // "account.page" -> the account module, like the live route handler.
    expect(reverseErrors["account-page"]).toBeUndefined();
    expect(resolved["account-page"]).toBe("/acme/settings");
  });

  it("stamps the DSL position's scope on the def", () => {
    expect((rootLayout as any).$$reverseScope).toEqual({
      prefix: undefined,
      rootScoped: true,
    });
    expect((accountLayout as any).$$reverseScope).toEqual({
      prefix: "account",
      rootScoped: false,
    });
    expect((projectLayout as any).$$reverseScope).toEqual({
      prefix: "account.project",
      rootScoped: false,
    });
    expect((projectSlot as any).$$reverseScope).toEqual({
      prefix: "account.project",
      rootScoped: false,
    });
    // A route also carries its full name, which the bake keeps resolving from.
    expect((accountPage as any).$$routeName).toBe("account.page");
  });
});
