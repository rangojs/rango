import { Static, urls } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

/**
 * A Static() layout or parallel slot bakes ctx.reverse(".name") in the module
 * that declares it, exactly as the same segment resolves it live.
 *
 * Mounted in urls.tsx as
 *   include("/static-scope", staticReverseScopePatterns, { name: "" })
 * — a transparent include, so this layout and its slot sit at root scope with
 * no name prefix, the scope a router's root layout bakes in. Below it
 * include(..., { name: "outer" }) holds a layout at prefix "outer" and
 * include(..., { name: "inner" }) a layout and a slot at prefix "outer.inner".
 * Both the outer and the inner module name a route "settings": resolving one
 * include too high bakes the outer module's URL for the inner segments.
 *
 * No route here takes a param: a build-time bake has no request params to
 * autofill, so a parameterized route would throw Missing param instead of
 * showing which route name the dot resolved to.
 */
export const StaticScopeRootLayout = Static((ctx) => (
  <div data-testid="srs-root-layout">
    <span data-testid="srs-root-home">{ctx.reverse(".staticScopeHome")}</span>
    <ParallelOutlet name="@aside" />
    <Outlet />
  </div>
));

export const StaticScopeRootSlot = Static((ctx) => (
  <aside data-testid="srs-root-slot">
    <span data-testid="srs-root-slot-home">
      {ctx.reverse(".staticScopeHome")}
    </span>
  </aside>
));

export const StaticScopeOuterLayout = Static((ctx) => (
  <div data-testid="srs-outer-layout">
    <span data-testid="srs-outer-settings">{ctx.reverse(".settings")}</span>
    <Outlet />
  </div>
));

export const StaticScopeInnerLayout = Static((ctx) => (
  <div data-testid="srs-inner-layout">
    <span data-testid="srs-inner-settings">{ctx.reverse(".settings")}</span>
    <ParallelOutlet name="@aside" />
    <Outlet />
  </div>
));

export const StaticScopeInnerSlot = Static((ctx) => (
  <aside data-testid="srs-inner-slot">
    <span data-testid="srs-slot-settings">{ctx.reverse(".settings")}</span>
  </aside>
));

const innerPatterns = urls(({ path, layout, parallel }) => [
  layout(StaticScopeInnerLayout, () => [
    parallel({ "@aside": StaticScopeInnerSlot }),
    path(
      "/settings",
      () => <div data-testid="srs-inner-settings-page">Inner settings</div>,
      { name: "settings" },
    ),
  ]),
]);

const outerPatterns = urls(({ path, layout, include }) => [
  layout(StaticScopeOuterLayout, () => [
    path(
      "/settings",
      () => <div data-testid="srs-outer-settings-page">Outer settings</div>,
      { name: "settings" },
    ),
    include("/inner", innerPatterns, { name: "inner" }),
  ]),
]);

export const staticReverseScopePatterns = urls(
  ({ path, layout, include, parallel }) => [
    layout(StaticScopeRootLayout, () => [
      // A slot at root scope: its bake has no name prefix to fall back on, the
      // shape that threw Unknown route before the fix.
      parallel({ "@aside": StaticScopeRootSlot }),
      path(
        "/home",
        () => <div data-testid="srs-home-page">Static scope home</div>,
        { name: "staticScopeHome" },
      ),
      include("/outer", outerPatterns, { name: "outer" }),
    ]),
  ],
);
