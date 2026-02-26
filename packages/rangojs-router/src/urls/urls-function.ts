import type { DefaultEnv } from "../types.js";
import type { AllUseItems } from "../route-types.js";
import { getContext } from "../server/context";
import { invariant } from "../errors";
import { createRouteHelpers } from "../route-definition.js";
import type { PathDefinition, UrlPatterns } from "./pattern-types.ts";
import type { PathHelpers } from "./path-helper-types.ts";
import type { ExtractRoutes, ExtractResponses } from "./type-extraction.ts";
import { createPathHelper, attachPathResponseTags } from "./path-helper.ts";
import { createIncludeHelper, processItems } from "./include-helper.ts";

/**
 * Define URL patterns with Django-inspired syntax
 *
 * Replaces map() as the entry point for route definitions.
 * URL patterns are now visible at the definition site via path().
 *
 * @example
 * ```typescript
 * export const blogPatterns = urls(({ path, layout, loader }) => [
 *   layout(BlogLayout, () => [
 *     path("/", BlogIndex, { name: "index" }),
 *     path("/:slug", BlogPost, { name: "post" }, () => [
 *       loader(PostLoader),
 *     ]),
 *   ]),
 * ]);
 * ```
 */
export function urls<
  TEnv = DefaultEnv,
  const TItems extends readonly (AllUseItems | readonly AllUseItems[])[] =
    readonly AllUseItems[],
>(
  builder: (helpers: PathHelpers<TEnv>) => TItems,
): UrlPatterns<TEnv, ExtractRoutes<TItems>, ExtractResponses<TItems>> {
  // Collect path definitions during build
  const definitions: PathDefinition[] = [];

  // Create the handler function that will be called by the router
  const handler = () => {
    invariant(
      typeof builder === "function",
      "urls() expects a builder function as its argument",
    );

    // Get base helpers from the existing route-definition module
    const baseHelpers = createRouteHelpers<any, TEnv>();

    // Create the path helper (with .json, .text, .html, .xml, .image, .stream, .any tags)
    const pathHelper = attachPathResponseTags(createPathHelper<TEnv>());

    // Create the include helper
    const includeHelper = createIncludeHelper<TEnv>();

    // Combine all helpers
    // Note: layout and cache are cast to their typed versions - phantom types don't affect runtime
    const helpers: PathHelpers<TEnv> = {
      path: pathHelper as any,
      include: includeHelper as any,
      layout: baseHelpers.layout as PathHelpers<TEnv>["layout"],
      parallel: baseHelpers.parallel as PathHelpers<TEnv>["parallel"],
      intercept: baseHelpers.intercept as PathHelpers<TEnv>["intercept"],
      middleware: baseHelpers.middleware,
      revalidate: baseHelpers.revalidate,
      loader: baseHelpers.loader,
      loading: baseHelpers.loading,
      errorBoundary: baseHelpers.errorBoundary,
      notFoundBoundary: baseHelpers.notFoundBoundary,
      when: baseHelpers.when,
      cache: baseHelpers.cache as PathHelpers<TEnv>["cache"],
      transition: baseHelpers.transition as PathHelpers<TEnv>["transition"],
    };

    // Execute builder directly - manifest.ts handles RootLayout wrapping
    // for inline handlers (non-Promise results).
    // For nested include() calls, routes inherit the outer RootLayout.
    const builderResult = builder(helpers).flat(3) as AllUseItems[];
    return processItems(builderResult);
  };

  // trailingSlash config is populated when handler() runs
  // We expose it via a getter that reads from the context after handler execution
  return {
    definitions,
    handler,
    get trailingSlash() {
      // Get the trailingSlash map from the current context
      // This will be populated after handler() is called
      const store = getContext();
      const ctx = store.context.getStore();
      if (!ctx?.trailingSlash) {
        return {};
      }
      return Object.fromEntries(ctx.trailingSlash);
    },
  } as UrlPatterns<TEnv, ExtractRoutes<TItems>, ExtractResponses<TItems>>;
}
