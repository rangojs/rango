import { createRouter } from "@rangojs/router";
import { accountPath } from "../../account-path.js";
import { Brand, BrandLoader } from "../../brand.js";
import { cacheStore } from "../../cache-store.js";
import { Document } from "../../document.js";
import {
  PrefetchActionInvalidationButton,
  PrefetchInvalidationButton,
} from "./PrefetchInvalidationButton.js";

export const router = createRouter({
  document: Document,
  defaultPrefetch: "viewport",
  cache: { store: cacheStore },
})
  .use(async (ctx, next) => {
    ctx.set(Brand, "brand-a");
    await next();
  })
  .routes(({ path, loader, cache }) => [
    // App B mounts the same cached loader on the same path, with its own brand.
    path(
      "/brand",
      async (ctx) => (
        <main data-testid="brand">
          {`App A ${(await ctx.use(BrandLoader)).brand}`}
        </main>
      ),
      { name: "brand" },
      () => [loader(BrandLoader, () => [cache({ ttl: 300 })])],
    ),
    // App B names its own path `account` and calls the same "use cache"
    // function from the same /nav.
    path("/a-account", () => <main>App A account</main>, { name: "account" }),
    path(
      "/nav",
      async (ctx) => (
        <main data-testid="nav">{`App A ${await accountPath(ctx)}`}</main>
      ),
      { name: "nav" },
    ),
    // App B has the same route name and path: with the hostOverride cookie
    // only the router tells the two shells apart.
    path("/shelled", () => <main data-testid="shelled">App A shelled</main>, {
      name: "shelled",
      ppr: true,
    }),
    path(
      "/",
      () => (
        <>
          <main data-testid="app">App A home</main>
          <a
            href="/?delegated-prefetch=1"
            data-testid="prefetch-invalidation-target"
          >
            Persistent invalidation target
          </a>
          <PrefetchInvalidationButton />
          <PrefetchActionInvalidationButton />
        </>
      ),
      {
        name: "home",
      },
    ),
  ]);
