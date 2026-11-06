import { Static, urls } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

/**
 * A Static() layout or parallel slot bakes ctx.reverse(".name") in the module
 * that declares it, exactly as the same segment resolves it live.
 *
 * Mounted in urls.tsx as
 *   include("/static-scope", staticReverseScopePatterns, { name: "" })
 * — a transparent include, so this layout sits at root scope with no name
 * prefix, the scope a router's root layout bakes in. Below it
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
    <Outlet />
  </div>
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

/**
 * A Static() route whose handler copies its ctx (`{ ...ctx }`), an ordinary
 * call shape a live handler's all-data ctx supports. The build-time ctx reads
 * its unavailable properties through non-enumerable accessors, so the copy
 * skips them instead of throwing before the handler reaches `reverse`.
 */
export const StaticScopeSpreadPage = Static((ctx) => {
  const copy = { ...ctx };
  return (
    <div data-testid="srs-spread-page">
      <span data-testid="srs-spread-home">
        {copy.reverse("staticScopeHome")}
      </span>
    </div>
  );
});

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

export const staticReverseScopePatterns = urls(({ path, layout, include }) => [
  layout(StaticScopeRootLayout, () => [
    path(
      "/home",
      () => <div data-testid="srs-home-page">Static scope home</div>,
      { name: "staticScopeHome" },
    ),
    path("/spread", StaticScopeSpreadPage, { name: "staticScopeSpread" }),
    include("/outer", outerPatterns, { name: "outer" }),
  ]),
]);
