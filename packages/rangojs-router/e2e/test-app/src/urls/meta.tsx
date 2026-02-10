import { urls } from "@rangojs/router";
import {
  MetaTemplateLayout,
  MetaTemplateNestedLayout,
  MetaUnsetLayout,
  MetaMergeLayout,
  MetaMergeMiddleLayout,
} from "../components/layouts/index.js";
import {
  MetaTemplateIndexHandler,
  MetaTemplateChildHandler,
  MetaTemplateAbsoluteHandler,
  MetaTemplateNestedHandler,
  MetaTemplateNestedChildHandler,
  MetaUnsetIndexHandler,
  MetaUnsetChildHandler,
  MetaUnsetThenSetHandler,
  MetaMergeIndexHandler,
  MetaMergeChildHandler,
  MetaMergeDeepHandler,
  HandlePassthroughHandler,
  HandlePassthroughAsyncHandler,
  HydrationTestHandler,
  TrailingSlashIgnoreHandler,
  TrailingSlashAlwaysHandler,
  TrailingSlashNeverHandler,
} from "./meta.handlers.js";

/**
 * Meta template routes URL patterns
 * Routes: metaTemplate.index, metaTemplate.child, metaTemplate.absolute, metaTemplate.nested, metaTemplate.nestedChild
 */
export const metaTemplatePatterns = urls(({ path, layout }) => [
  layout(MetaTemplateLayout, () => [
    path("/", MetaTemplateIndexHandler, { name: "index" }),
    path("/child", MetaTemplateChildHandler, { name: "child" }),
    path("/absolute", MetaTemplateAbsoluteHandler, { name: "absolute" }),

    // Nested layout with its own template - overrides parent template
    layout(MetaTemplateNestedLayout, () => [
      path("/nested", MetaTemplateNestedHandler, { name: "nested" }),
      path("/nested/child", MetaTemplateNestedChildHandler, { name: "nestedChild" }),
    ]),
  ]),
]);

/**
 * Meta unset routes URL patterns
 * Routes: metaUnset.index, metaUnset.child, metaUnset.unsetThenSet
 */
export const metaUnsetPatterns = urls(({ path, layout }) => [
  layout(MetaUnsetLayout, () => [
    path("/", MetaUnsetIndexHandler, { name: "index" }),
    path("/child", MetaUnsetChildHandler, { name: "child" }),
    path("/unset-then-set", MetaUnsetThenSetHandler, { name: "unsetThenSet" }),
  ]),
]);

/**
 * Meta merge routes URL patterns
 * Routes: metaMerge.index, metaMerge.child, metaMerge.deep
 */
export const metaMergePatterns = urls(({ path, layout }) => [
  layout(MetaMergeLayout, () => [
    path("/", MetaMergeIndexHandler, { name: "index" }),
    path("/child", MetaMergeChildHandler, { name: "child" }),

    // Deep nested - multiple levels of overrides
    layout(MetaMergeMiddleLayout, () => [
      path("/deep/nested", MetaMergeDeepHandler, { name: "deep" }),
    ]),
  ]),
]);

/**
 * Handle passthrough routes (not nested in meta layouts)
 * Routes: handlePassthrough, handlePassthroughAsync
 */
export const handlePatterns = urls(({ path, loading }) => [
  path("/handle-passthrough", HandlePassthroughHandler, { name: "handlePassthrough" }),
  path(
    "/handle-passthrough-async",
    HandlePassthroughAsyncHandler,
    { name: "handlePassthroughAsync" },
    () => [
      loading(
        <div data-testid="async-passthrough-loading">
          <p>Loading async child...</p>
        </div>
      ),
    ]
  ),
]);

/**
 * Hydration test route
 */
export const hydrationPatterns = urls(({ path }) => [
  path("/hydration-test", HydrationTestHandler, { name: "hydrationTest" }),
]);

/**
 * Trailing slash routes
 */
export const trailingSlashPatterns = urls(({ path }) => [
  path("/ts-ignore", TrailingSlashIgnoreHandler, { name: "trailingSlash.ignore", trailingSlash: "ignore" }),
  path("/ts-always", TrailingSlashAlwaysHandler, { name: "trailingSlash.always", trailingSlash: "always" }),
  path("/ts-never", TrailingSlashNeverHandler, { name: "trailingSlash.never", trailingSlash: "never" }),
]);
