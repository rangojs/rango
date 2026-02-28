import { urls } from "@rangojs/router";
import {
  LoaderReverseGlobalLoader,
  LoaderReverseScopedLoader,
  LoaderReverseClientGlobalLoader,
  LoaderReverseClientScopedLoader,
  LoaderReverseFetchScopedLoader,
} from "../loaders.js";
import {
  LoaderReverseClientGlobal,
  LoaderReverseClientScoped,
  LoaderReverseFetchScoped,
} from "../components/LoaderReverseClient.js";

/**
 * Test patterns for ctx.reverse inside loaders.
 *
 * Tests:
 * 1. Global reverse in a loader consumed via ctx.use (server-side)
 * 2. Scoped reverse in a loader consumed via ctx.use (server-side)
 * 3. Global reverse in a fetchable loader consumed via useLoader (client-bound)
 * 4. Scoped reverse in a fetchable loader consumed via useLoader (client-bound)
 */
export const loaderReversePatterns = urls(({ path, loader }) => [
  // Index route: server-consumed loaders via ctx.use()
  // and client-bound fetchable loaders via useLoader()
  path(
    "/",
    async (ctx) => {
      const globalData = await ctx.use(LoaderReverseGlobalLoader);
      const scopedData = await ctx.use(LoaderReverseScopedLoader);

      return (
        <div data-testid="loader-reverse-page">
          <h1 data-testid="loader-reverse-title">Loader Reverse Test</h1>

          <section>
            <h2>Global reverse from loader (ctx.use)</h2>
            <ul>
              <li data-testid="loader-global-blog-index">
                {globalData.blogIndex}
              </li>
              <li data-testid="loader-global-blog-post">
                {globalData.blogPost}
              </li>
              <li data-testid="loader-global-href-index">
                {globalData.hrefIndex}
              </li>
            </ul>
          </section>

          <section>
            <h2>Scoped reverse from loader (ctx.use)</h2>
            <ul>
              <li data-testid="loader-scoped-index">{scopedData.localIndex}</li>
              <li data-testid="loader-scoped-detail">
                {scopedData.localDetail}
              </li>
              <li data-testid="loader-scoped-global-blog">
                {scopedData.globalBlog}
              </li>
            </ul>
          </section>

          <LoaderReverseClientGlobal
            loader={LoaderReverseClientGlobalLoader}
          />
          <LoaderReverseClientScoped
            loader={LoaderReverseClientScopedLoader}
          />
          <LoaderReverseFetchScoped
            loader={LoaderReverseFetchScopedLoader}
          />
        </div>
      );
    },
    { name: "index" },
    () => [
      loader(LoaderReverseGlobalLoader),
      loader(LoaderReverseScopedLoader),
      loader(LoaderReverseClientGlobalLoader),
      loader(LoaderReverseClientScopedLoader),
      loader(LoaderReverseFetchScopedLoader),
    ],
  ),

  // Detail route (for scoped reverse .detail target)
  path(
    "/:id",
    (ctx) => (
      <div data-testid="loader-reverse-detail-page">
        <h1 data-testid="loader-reverse-detail-title">
          Detail: {ctx.params.id}
        </h1>
      </div>
    ),
    { name: "detail" },
  ),
]);
