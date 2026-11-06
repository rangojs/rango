import { describe, it, expect, vi } from "vitest";

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

// A Static() layout or slot bakes ctx.reverse(".name") in the include scope
// that declared it, like the segment's live ctx (withReverseScope). The bake
// used to pass the def's include name prefix as if it were a route name, and
// resolveRouteName strips a route name's last segment: a layout at prefix
// "mid.deep" resolved ".settings" from "mid" and baked the outer module's URL.
// At root scope the prefix is empty, so ".home" threw Unknown route while the
// same layout resolved it live.
const baked: Record<string, { value?: string; error?: unknown }> = {};

function capture(key: string, name: string) {
  return Static((ctx: any) => {
    try {
      baked[key] = { value: ctx.reverse(name) };
    } catch (error) {
      baked[key] = { error };
    }
    // Halt before Flight encoding: the assertions are about reverse().
    throw new Error("halt-before-encode");
  });
}

const rootLayout = capture("root", ".home");
const outerLayout = capture("outer", ".settings");
const innerLayout = capture("inner", ".settings");
const innerSlot = capture("slot", ".settings");
// A Static() route whose own local name carries a dot: a route's dot names
// resolve from its route name, as its live handler's do, not from a scope.
const dottedRoute = capture("route", ".settings");

const innerPatterns = urls(({ path, layout, parallel }) => [
  layout(innerLayout, () => [
    parallel({ "@aside": innerSlot }),
    path("/settings", () => null, { name: "settings" }),
  ]),
]);

const outerPatterns = urls(({ path, layout, include }) => [
  layout(outerLayout, () => [
    path("/settings", () => null, { name: "settings" }),
    path("/blog/settings", () => null, { name: "blog.settings" }),
    path("/dotted", dottedRoute, { name: "blog.post" }),
    include("/inner", innerPatterns, { name: "inner" }),
  ]),
]);

const patterns = urls(({ path, layout, include }) => [
  layout(rootLayout, () => [
    path("/home", () => null, { name: "home" }),
    include("/outer", outerPatterns, { name: "outer" }),
  ]),
]);

const router = createRouter({
  id: "static-reverse-scope",
  $$routeNames: {
    home: "/home",
    "outer.settings": "/outer/settings",
    "outer.blog.settings": "/outer/blog/settings",
    "outer.blog.post": "/outer/dotted",
    "outer.inner.settings": "/outer/inner/settings",
  },
}).routes(patterns) as unknown as RangoInternal<any, any>;

/** The collector's exact production call (prerender-collection.ts). */
async function bake(def: any): Promise<void> {
  // Only a mounted layout or slot has a ReverseScope: path() stamps a route
  // name, layout() and parallel() stamp the include prefix and root scope.
  const reverseScope =
    def.$$routeName === undefined && def.$$rootScoped !== undefined
      ? { prefix: def.$$routePrefix, rootScoped: def.$$rootScoped }
      : undefined;
  await router
    .renderStaticSegment(
      def.handler,
      def.$$id,
      def.$$routeName ?? def.$$routePrefix,
      undefined,
      undefined,
      def.$$rootScoped,
      reverseScope,
    )
    .catch(() => {});
}

describe("Static() layout and slot reverse scope at bake time", () => {
  it("resolves dot-local names in the def's own include scope", async () => {
    // Mirror discovery: include children evaluate lazily, so the defs are
    // stamped during manifest generation, not at createRouter().
    await generateManifestFull(patterns, 0, {
      routerId: "static-reverse-scope",
    });

    for (const [key, def] of [
      ["root", rootLayout],
      ["outer", outerLayout],
      ["inner", innerLayout],
      ["slot", innerSlot],
      ["route", dottedRoute],
    ] as const) {
      await bake(def);
    }

    // Every row in one assertion: a bake that resolves one include too high
    // reports the outer module's URL, which the diff names per segment.
    const actual = Object.fromEntries(
      Object.entries(baked).map(([key, result]) => [
        key,
        result.error ? `ERROR: ${String(result.error)}` : result.value,
      ]),
    );
    expect(actual).toEqual({
      // Root scope has no name prefix; the bare-name fallback resolves it.
      root: "/home",
      // Prefix "outer": one include deep the prefix and the stripped route
      // name agree, so this row passed before the fix too.
      outer: "/outer/settings",
      inner: "/outer/inner/settings",
      // A slot is stamped at its parallel() position, the inner module here.
      slot: "/outer/inner/settings",
      // "outer.blog.post" minus its last segment is "outer.blog": a route def
      // keeps resolving from its route name, not from the "outer" module.
      route: "/outer/blog/settings",
    });
  });
});
