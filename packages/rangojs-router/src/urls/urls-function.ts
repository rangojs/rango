import type { DefaultEnv } from "../types.js";
import type { AllUseItems } from "../route-types.js";
import { getContext } from "../server/context";
import { invariant } from "../errors";
import { createRouteHelpers } from "../route-definition.js";
import { assertDeclaredIn } from "../route-definition/dsl-helpers.js";
import type { UrlPatterns } from "./pattern-types.js";
import type { PathHelpers } from "./path-helper-types.js";
import type { ExtractRoutes, ExtractResponses } from "./type-extraction.js";
import { createPathHelper, attachPathResponseTags } from "./path-helper.js";
import { createIncludeHelper, processItems } from "./include-helper.js";

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
  const handler = () => {
    invariant(
      typeof builder === "function",
      "urls() expects a builder function as its argument",
    );

    const baseHelpers = createRouteHelpers<any, TEnv>();

    const pathHelper = attachPathResponseTags(createPathHelper<TEnv>());

    const includeHelper = createIncludeHelper<TEnv>();

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
      cache: baseHelpers.cache as PathHelpers<TEnv>["cache"],
      transition: baseHelpers.transition as PathHelpers<TEnv>["transition"],
    };

    // The list's entry is the parent before the builder runs: an orphan cache()
    // marker inside the builder moves ctx.parent down to its own entry.
    const listEntry = getContext().getParent();
    const builderResult = builder(helpers).flat(3) as AllUseItems[];
    // The top-level array nests items like any callback does: a definition
    // created above a cache() marker and listed after it renders outside the
    // cache while reading as if it were inside.
    assertDeclaredIn(listEntry, builderResult);
    return processItems(builderResult);
  };

  return {
    handler,
    get trailingSlash() {
      const store = getContext();
      const ctx = store.context.getStore();
      if (!ctx?.trailingSlash) {
        return {};
      }
      return Object.fromEntries(ctx.trailingSlash);
    },
  } as UrlPatterns<TEnv, ExtractRoutes<TItems>, ExtractResponses<TItems>>;
}
