import { createRouter } from "@rangojs/router";
import { accountPath } from "../../account-path.js";
import { Brand, BrandLoader } from "../../brand.js";
import { cacheStore } from "../../cache-store.js";
import { Document } from "../../document.js";

export const router = createRouter({
  document: Document,
  cache: { store: cacheStore },
})
  .use(async (ctx, next) => {
    ctx.set(Brand, "brand-b");
    await next();
  })
  .routes(({ path, loader, cache }) => [
    path("/", () => <main data-testid="app">App B home</main>, {
      name: "home",
    }),
    path("/shelled", () => <main data-testid="shelled">App B shelled</main>, {
      name: "shelled",
      ppr: true,
    }),
    path(
      "/brand",
      async (ctx) => (
        <main data-testid="brand">
          {`App B ${(await ctx.use(BrandLoader)).brand}`}
        </main>
      ),
      { name: "brand" },
      () => [loader(BrandLoader, () => [cache({ ttl: 300 })])],
    ),
    path("/b-account", () => <main>App B account</main>, { name: "account" }),
    path(
      "/nav",
      async (ctx) => (
        <main data-testid="nav">{`App B ${await accountPath(ctx)}`}</main>
      ),
      { name: "nav" },
    ),
  ]);
