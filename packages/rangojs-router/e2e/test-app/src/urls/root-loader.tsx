import { urls } from "@rangojs/router";
import { RootLevelTestLoader } from "../loaders.js";

/**
 * Test patterns for root-level (orphan) loader.
 *
 * The loader() is placed at the root of urls(), NOT inside a path's children.
 * This tests that loaders attached to the implicit RootLayout entry work
 * correctly and can be consumed via ctx.use() in path handlers.
 */
export const rootLoaderPatterns = urls(({ path, loader }) => [
  loader(RootLevelTestLoader),

  path(
    "/",
    async (ctx) => {
      const data = await ctx.use(RootLevelTestLoader);
      return (
        <div data-testid="root-loader-page">
          <h1 data-testid="root-loader-title">Root Loader Test</h1>
          <p data-testid="root-loader-source">{data.source}</p>
          <p data-testid="root-loader-timestamp">{data.timestamp}</p>
        </div>
      );
    },
    { name: "index" },
  ),
]);
