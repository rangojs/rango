# A docs site and a blog

A content site: docs written as files in the repository, a blog fed by a
CMS, a home page, and the machine routes (sitemap, robots, feeds). Almost
every page is the same for every visitor, so almost every page is built
ahead of the request.

- **Docs** change only when the repository does: `Prerender` renders every
  page at build time and `ppr` bakes each page's HTML shell too. The nav is a
  `Static` segment rendered once.
- **The blog** changes when an editor publishes: `Prerender` with `onDemand`
  bakes the newest posts at build, a publish webhook re-renders one post with
  `router.prerender()`, and `Passthrough()` renders anything else live.
- **Each section is one module** mounted with a sync `include()`.

Prerendering is caching at build time: the worker still handles every
request and reads the stored payload the way it reads a cache hit, so
middleware and loaders still run (`/prerender`). The repository's own docs
site, `apps/docs`, is this shape in one module: `Prerender` pages with `ppr`,
a `Static` nav in a parallel slot, and `path.text()` / `path.xml()` machine
routes.

## File tree

```
src/
  worker.rsc.tsx              Cloudflare entry, plus the publish webhook
  publish.ts                  the webhook: router.prerender() for the changed pages
  router.tsx                  cache store (shells) and prerender store (refreshes)
  router.named-routes.gen.ts  generated, committed
  env.ts
  urls.tsx                    root: site layout, docs, blog, machine routes
  urls/
    docs.tsx                  urls(): DocsLayout, nav slot, pages
    blog.tsx                  urls(): index, posts
    machine.tsx               urls(): sitemap.xml, robots.txt
  pages/
    docs.tsx                  DocsNav (Static), DocsLayout, DocPage and DocsIndex (Prerender)
    blog.tsx                  BlogPostDef (Prerender, onDemand), BlogPost (Passthrough), BlogIndex
    site.tsx                  SiteLayout, HomePage
  lib/content.ts              docs from files, posts from the CMS
```

`Prerender` and `Static` definitions are exported `const`s in their own
modules, never written inline in `path()`: the build injects their ids from
the export and evicts their handlers from the production bundle.

## router.tsx

```tsx
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";
import { createKVPrerenderStore } from "@rangojs/router/prerender/cloudflare";
import type { AppBindings } from "./env";
import { urlpatterns } from "./urls";

export const router = createRouter<AppBindings>({
  // ppr shells and runtime caches.
  cache: (env, ctx) => ({
    store: new CFCacheStore({ kv: env.CACHE_KV, ctx: ctx! }),
  }),
  // Where on-demand refreshes are written, and read before the build's payloads.
  prerender: (env) => ({ store: createKVPrerenderStore(env.PRERENDER_KV) }),
}).routes(urlpatterns);
```

On Node, `MemorySegmentCacheStore` and `createMemoryPrerenderStore()` (from
`@rangojs/router/prerender`) are the single-process stores. In dev, an
in-memory prerender store is used when the option is absent.

## urls.tsx

```tsx
// src/urls.tsx
import { urls } from "@rangojs/router";
import { docsPatterns } from "./urls/docs";
import { blogPatterns } from "./urls/blog";
import { machinePatterns } from "./urls/machine";
import { HomePage, SiteLayout } from "./pages/site";

export const urlpatterns = urls(({ path, layout, include }) => [
  layout(SiteLayout, () => [
    path("/", HomePage, { name: "home", ppr: true }),
    include("/docs", docsPatterns, { name: "docs" }),
    include("/blog", blogPatterns, { name: "blog" }),
  ]),
  // Outside the layout: no chrome. Flattened names: sitemap, robots.
  include("/", machinePatterns, { name: "" }),
]);
```

## The docs section

```tsx
// src/pages/docs.tsx
import { notFound, Prerender, Static } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { docs } from "../lib/content";

// Rendered once at build time and shared by every docs page.
export const DocsNav = Static(async (ctx) => {
  const all = await docs.all();
  return (
    <ul>
      {all.map((d) => (
        <li key={d.slug}>
          <Link to={ctx.reverse("docs.page", { slug: d.slug })}>{d.title}</Link>
        </li>
      ))}
    </ul>
  );
});

export function DocsLayout() {
  return (
    <div className="docs">
      <aside>
        <ParallelOutlet name="@nav" />
      </aside>
      <Outlet />
    </div>
  );
}

// Every page is known at build time: one payload per slug.
export const DocPage = Prerender<{ slug: string }>(
  async () => (await docs.all()).map((d) => ({ slug: d.slug })),
  async (ctx) => {
    const doc = await docs.get(ctx.params.slug);
    if (!doc) notFound();
    return <article>{doc.body}</article>;
  },
);

export const DocsIndex = Prerender(async () => <h1>Docs</h1>);
```

```tsx
// src/urls/docs.tsx
import { urls } from "@rangojs/router";
import { DocPage, DocsIndex, DocsLayout, DocsNav } from "../pages/docs";

export const docsPatterns = urls(({ path, layout, parallel }) => [
  layout(DocsLayout, () => [
    parallel({ "@nav": DocsNav }),
    // Prerender + ppr: the build also bakes each page's HTML shell.
    path("/", DocsIndex, { name: "index", ppr: true }),
    path("/:slug", DocPage, { name: "page", ppr: true }),
  ]),
]);
```

- A slug that `getParams` did not list answers 404 in production: a plain
  `Prerender` has no live handler left to render it.
- A content edit is a deploy: the new build bakes new payloads and shells,
  and replaces the stored HTML of that router while keeping its cached data
  (a Prerender payload is part of its router's document version).
- A build shell is keyed by pathname and serves requests without a query
  string; a URL with search params is captured at runtime.

## The blog section

```tsx
// src/pages/blog.tsx
import { notFound, Passthrough, Prerender } from "@rangojs/router";
import { cms, type Post } from "../lib/content";

function Article({ post }: { post: Post }) {
  return <article>{post.body}</article>;
}

// The newest published posts bake at build. A refresh re-renders one post
// and serves that to everyone; ttl only decides when it counts as stale.
export const BlogPostDef = Prerender<{ slug: string }>(
  async () => (await cms.posts({ limit: 50 })).map((p) => ({ slug: p.slug })),
  async (ctx) => {
    const post = await cms.post(ctx.params.slug);
    // A refresh that hits notFound() removes the page: 404 from then on.
    if (!post || post.draft) notFound();
    return <Article post={post} />;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`post:${params.slug}`] } },
);

// Older posts, and new ones nothing has refreshed yet, render live.
export const BlogPost = Passthrough(BlogPostDef, async (ctx) => {
  const post = await cms.post(ctx.params.slug);
  if (!post || post.draft) notFound();
  return <Article post={post} />;
});

export const BlogIndex = Prerender(
  async () => {
    const posts = await cms.posts({ limit: 20 });
    return (
      <ul>
        {posts.map((p) => (
          <li key={p.slug}>{p.title}</li>
        ))}
      </ul>
    );
  },
  { onDemand: { tags: ["blog-index"] } },
);
```

```tsx
// src/urls/blog.tsx
import { urls } from "@rangojs/router";
import { BlogIndex, BlogPost } from "../pages/blog";

// onDemand and ppr cannot be combined (the route definition throws):
// these routes take no ppr option.
export const blogPatterns = urls(({ path }) => [
  path("/", BlogIndex, { name: "index" }),
  path("/:slug", BlogPost, { name: "post" }),
]);
```

| Request for                | Served from                                                                      |
| -------------------------- | -------------------------------------------------------------------------------- |
| A post the build baked     | its build payload, until a refresh stores a newer one                            |
| A refreshed post           | the refreshed entry, read before the build payload                               |
| Any other post             | the `Passthrough` live handler                                                   |
| A draft                    | not listed by `getParams`; the live handler answers 404                          |
| A post moved back to draft | its refresh hits `notFound()` and stores a removal; the live handler answers 404 |

`throw new Skip()` leaves one entry out of a build without failing it, but
in a refresh it reports `render-failed` and keeps the previous entry: a
published post that went back to draft would keep serving. Use `notFound()`
for content that should disappear, or `prerender.remove(url)`.
`updateTag()` does not reach prerendered payloads; a refresh does
(`/prerender` → "On-demand refresh (ISR)").

## The publish webhook

The webhook needs the router, so it lives beside the entry and not in the
route tree: a route module that imports `router.tsx` is an import cycle
([`./SKILL.md`](./SKILL.md#the-rules-every-recipe-follows)).

```ts
// src/publish.ts
import type { AppBindings } from "./env";
import { router } from "./router";

export async function cmsPublish(
  request: Request,
  env: AppBindings,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.headers.get("x-cms-secret") !== env.CMS_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  const { slug } = (await request.json()) as { slug: string };
  const prerender = router.prerender({ env, ctx });
  const [post, index] = await prerender.many([`/blog/${slug}`, "/blog"]);
  return Response.json({ post: post?.status, index: index?.status });
}
```

```tsx
// src/worker.rsc.tsx
import type { AppBindings } from "./env";
import { router } from "./router";
import { cmsPublish } from "./publish";

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/hooks/cms-publish") {
      return cmsPublish(request, env, ctx);
    }
    return router.fetch(request, { env, ctx });
  },
} satisfies ExportedHandler<AppBindings>;
```

A refresh renders with route params and env only, no request, and returns a
status (`rendered`, `removed` when the render hit `notFound()`,
`render-failed`, …); every failure keeps the previous entry. A deleted post
is `prerender.remove("/blog/<slug>")`. Thousands of pages belong in a queue,
one batch per message, and `onRevalidate` in the `prerender` option can
schedule a refresh when a request finds a stale entry.

## Machine routes

```tsx
// src/urls/machine.tsx
import { urls } from "@rangojs/router";
import { docs } from "../lib/content";

export const machinePatterns = urls(({ path }) => [
  path.xml(
    "/sitemap.xml",
    async (ctx) => {
      const pages = await docs.all();
      const locs = pages.map(
        (d) =>
          `<url><loc>${ctx.url.origin}${ctx.reverse("docs.page", { slug: d.slug })}</loc></url>`,
      );
      return `<?xml version="1.0"?><urlset>${locs.join("")}</urlset>`;
    },
    { name: "sitemap" },
  ),
  path.text("/robots.txt", () => "User-agent: *\nAllow: /\n", {
    name: "robots",
  }),
]);
```

Response routes skip the RSC pipeline; add `cache({ ttl })` as a use item to
store the whole response (`/response-routes`).

## Locales

Put the locale in the URL, as an optional, constrained mount param:
`include("/:locale(en|de)?", docsPatterns, { name: "docs" })`. A
prerendered page has no request to read a cookie or `Accept-Language` from,
and a `ppr` capture refuses a handler that reads them, so on a content site
the URL is the only locale signal those pages can use. Resolution chains and
message loading are in `/i18n`.

## Why

| Choice                                  | Why                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Prerender` for docs                    | Content known at build; handler and its file reads leave the bundle                               |
| `ppr` on docs pages                     | The build bakes the HTML too: the first document request is a shell HIT                           |
| `Static` nav in a parallel slot         | Rendered once for every page instead of once per page                                             |
| `onDemand` + `Passthrough` for the blog | Published posts serve from stored payloads; a refresh needs no deploy; the long tail renders live |
| The webhook beside the entry            | It needs the router; the route tree must not import it                                            |
| `{ name: "" }` for machine routes       | Short, unique names (`sitemap`), no chrome                                                        |
