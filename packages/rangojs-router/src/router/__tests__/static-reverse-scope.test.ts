import { describe, it, expect, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. The bake path under test never renders Flight (each handler
// halts after recording its reverse()), so a stub is sufficient.
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

// A Static() layout or slot bakes ctx.reverse(".name") in the module that
// defines it, at every nesting depth (root included) -- exactly as the same
// segment resolves live through its ReverseScope (withReverseScope,
// router/handler-context.ts). The bake handed the def's name PREFIX to
// resolveRouteName, which strips one more segment: a layout in the project
// module baked the account route, and a root-level layout had no prefix at all.
const baked: Record<string, string | undefined> = {};
const errors: Record<string, unknown> = {};

function record(key: string, resolve: (ctx: any) => string) {
  return Static((ctx: any) => {
    try {
      baked[key] = resolve(ctx);
    } catch (error) {
      errors[key] = error;
    }
    // Halt before Flight encoding: the assertions are about reverse().
    throw new Error("halt-before-encode");
  });
}

// Literal segments: a Static segment has no params, so a route with a required
// mount param could only bake `Missing param` in both the old and new code.
const ProjectLayout = record("project-layout", (ctx) =>
  ctx.reverse(".settings"),
);
const ProjectSlot = record("project-slot", (ctx) => ctx.reverse(".settings"));
const ProjectRoute = record("project-route", (ctx) => ctx.reverse(".settings"));
const RootLayout = record("root-layout", (ctx) => ctx.reverse(".home"));
const AccountLayout = record("account-layout", (ctx) =>
  ctx.reverse(".settings"),
);

const projectPatterns = urls(({ path, layout, parallel }) => [
  layout(ProjectLayout, () => [
    parallel({ "@aside": ProjectSlot }),
    path("/issues", ProjectRoute, { name: "issues" }),
    path("/settings", () => null, { name: "settings" }),
  ]),
]);

const accountPatterns = urls(({ path, layout, include }) => [
  layout(AccountLayout, () => [
    path("/settings", () => null, { name: "settings" }),
    include("/web", projectPatterns, { name: "project" }),
  ]),
]);

const patterns = urls(({ path, include }) => [
  path("/", () => null, { name: "home" }),
  include("/acme", accountPatterns, { name: "account" }),
]);

const router = createRouter({ id: "static-scope" }).routes(
  patterns,
) as unknown as RangoInternal<any, any>;

const rootPatterns = urls(({ path, layout, include }) => [
  layout(RootLayout, () => [
    path("/", () => null, { name: "home" }),
    include("/acme", accountPatterns, { name: "account" }),
  ]),
]);

const rootRouter = createRouter({ id: "static-scope-root" }).routes(
  rootPatterns,
) as unknown as RangoInternal<any, any>;

/**
 * Includes are lazy, so the router's route map fills on the first match, as
 * the build's generated named-routes seed fills it in a real app.
 */
async function warm(target: RangoInternal<any, any>, path: string) {
  await target
    .match(new Request(`http://localhost${path}`))
    .catch(() => undefined);
}

/** The collector's EXACT production call (vite/discovery/prerender-collection.ts). */
async function bake(target: RangoInternal<any, any>, def: any): Promise<void> {
  await target
    .renderStaticSegment(
      def.handler,
      def.$$id,
      def.$$routeName ?? def.$$routePrefix,
      undefined,
      undefined,
      def.$$reverseScope,
    )
    .catch(() => {});
}

describe("a Static() segment bakes ctx.reverse('.name') in its own module", () => {
  it("a layout and a slot in a nested module resolve in that module", async () => {
    await warm(router, "/acme/web/issues");

    await bake(router, ProjectLayout);
    await bake(router, ProjectSlot);

    // Both modules name "settings"; this module defines the project's. Before,
    // the prefix lost its last segment and baked /acme/settings.
    expect(errors["project-layout"]).toBeUndefined();
    expect(errors["project-slot"]).toBeUndefined();
    expect(baked["project-layout"]).toBe("/acme/web/settings");
    expect(baked["project-slot"]).toBe("/acme/web/settings");
  });

  it("a nested route's Static handler still resolves in its own module", async () => {
    await warm(router, "/acme/web/issues");

    await bake(router, ProjectRoute);

    expect(errors["project-route"]).toBeUndefined();
    expect(baked["project-route"]).toBe("/acme/web/settings");
  });

  it("a root-level layout resolves root-scope dot names", async () => {
    await warm(rootRouter, "/acme/web/issues");

    await bake(rootRouter, RootLayout);

    // Before: no prefix, so ".home" threw Unknown route at build.
    expect(errors["root-layout"]).toBeUndefined();
    expect(baked["root-layout"]).toBe("/");
  });

  it("an account-module layout resolves the account route, not the project's", async () => {
    await warm(router, "/acme/web/issues");

    await bake(router, AccountLayout);

    expect(errors["account-layout"]).toBeUndefined();
    expect(baked["account-layout"]).toBe("/acme/settings");
  });
});
