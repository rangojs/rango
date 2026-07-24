<!--
Editing contract for this page. The bar is: nothing aspirational.

- Every claim describes SHIPPED behavior, verified against the current
  source — not the roadmap, not a design doc, not an intended future default.
- Every claim carries either a snippet using the real public API (exact
  imports, exact signatures — copy from a skill or verify in src/) or a
  named, greppable mechanism (a file, an option, a trace reason).
- Features in progress belong in docs/design/ until they ship with dev+prod
  e2e coverage; only then may they appear here.
- When a public API used in a snippet here changes, update this page in the
  same PR — same rule as feature-map.md.
- The closing "What it costs" section is part of the contract: new trade-offs
  introduced by new claims get added there, not omitted.
- `pnpm check:docs-api` (CI lint) verifies that API identifiers referenced
  here still exist in router src — a failing run means the doc must be
  updated in the same PR as the rename.
-->

# Why Rango

There are plenty of React routers. A new one owes you a reason to exist, and
"Django-inspired" is a lineage, not a reason. This page is the actual reason:
the small set of load-bearing ideas that are different here, each shown in
code. If a section doesn't earn its place with a snippet, it doesn't appear.

The stance underneath all of them: **explicit over implicit, correct by
default, and the source is the source of truth.** Nothing below is magic —
every behavior is a stated contract you can read, test against, and grep for.

## The route tree is the app

Routes are expressed, not configured. One tree shows every URL, who owns it,
what data it loads, what wraps it, and what re-renders after an action — no
file-system convention, no hunting across `page.tsx` / `layout.tsx` /
`route.ts` siblings.

```tsx
export const urlpatterns = urls(
  ({ path, layout, loader, loading, cache, revalidate }) => [
    layout(<ShopLayout />, () => [
      loader(CartLoader, () => [
        revalidate((ctx) => ctx.isAction(CartActions) || undefined),
      ]),
      path("/shop/:slug", ProductPage, { name: "product" }, () => [
        loader(ProductLoader, () => [cache({ ttl: 60 })]),
        loading(<ProductSkeleton />),
      ]),
    ]),
  ],
);
```

The tree has one design rule: `path()` and `include()` are **structure** and
must stay visible here; everything else is **config** and extracts into
factories you can share (`withCaching()`, `withAuth()`). From this one file
you can answer the three questions that usually require a codebase tour:
what URLs exist and who owns them, can I trust this reference without leaving
the call site (`ctx.reverse("product")` is compile-time checked), and what
re-renders after this action.

Route groups code-split with `include("/shop", () => import("./shop"))` —
lazily loaded, still fully typed, so the tree scales without boot cost.

## Names, not strings

The opening said "Django-inspired" is a lineage, not a reason. This is the
part of the lineage that is a reason: every route carries a name, and URLs
are built from names, never hand-assembled from strings.

```tsx
// in a handler, action, or middleware — far from the tree
throw redirect(ctx.reverse("product", { slug: "espresso-cup" }));
```

`ctx.reverse()` on the server and `useReverse()` on the client are
compile-time checked against the generated route map: a misspelled name or a
missing param is a type error, not a runtime 404. The payoff is rename
safety — change `/shop/:slug` to `/store/:slug` in the one place it is
defined, and every link, redirect, and prefetch in the codebase follows.
There is no grep-for-the-old-URL migration, because no call site ever knew
the URL.

## Your API lives in the same tree

Response routes are ordinary tree entries — `path.json()`, `path.text()`,
`path.xml()`, `path.image()`, `path.stream()` — not a parallel routing
system. That buys two things most React frameworks don't have.

**Content negotiation out of the box.** The same URL can serve the RSC page
to a browser and JSON to an API client, dispatched by `Accept` header in the
route trie — no wrapper code, no `/api` mirror of your URL space:

```tsx
path("/products/:id", ProductPage, { name: "product" }),
path.json("/products/:id", (ctx) => db.getProduct(ctx.params.id), {
  name: "productJson",
}),
```

Handlers return bare values; errors serialize as RFC 9457
`application/problem+json`. External consumers get a clean, standard wire
with no client library required.

**Inferred endpoint types for first-party calls.** The payload type of every
response route is inferred from its handler — no codegen, no schema
duplication:

```ts
type Product = RouteResponse<typeof urlpatterns, "productJson">;
```

The [`/api-client` skill](../skills/api-client/SKILL.md) wraps this in a
small typed client (type-only imports, runs in browser, worker, or server),
so internal TypeScript code calls your endpoints like functions — typed
params, typed payload, typed `ProblemDetails` errors — while the same
endpoints stay plain HTTP for everyone else. RPC ergonomics without an RPC
protocol.

## Two axes of freshness, never conflated

Most framework caching pain is one conflation: "is the stored value fresh?"
and "should this segment re-render for this client update?" are different
questions, and mainstream APIs answer both with one word. Next.js
`revalidate = 60` is cache expiry; Remix `shouldRevalidate` is re-render
selection; both are called revalidation.

Rango keeps them orthogonal:

| Axis                    | Question                                 | API                                        |
| ----------------------- | ---------------------------------------- | ------------------------------------------ |
| Stored-value freshness  | Is this cached value still good?         | `cache({ ttl, swr, tags })`, `"use cache"` |
| Client-update selection | Should this segment re-render right now? | `revalidate((ctx) => ...)`                 |

They compose: a segment can be cached for ten minutes _and_ re-render
instantly after the one action that affects it (`updateTag()` busts the
value; `revalidate()` selects the segment). You never express one policy by
abusing the other.

## Loaders are the live lane — not your data-fetching layer

First, the default data path: handlers are async server components, so you
fetch where you render. React Router and Remix split data into a loader
beside the component because components couldn't fetch; RSC collapses that
split, and Rango doesn't reintroduce it.

`loader()` is a different tool, and the choice is semantic: **where you
fetch decides which side of the freshness boundary the data lives on.**
Handler data belongs to the shell — rendered with it, frozen with it when
cached. Loader data outlives the shell. A loader is a server function
attached to route segments in the tree; all of a route's loaders start in
parallel right after middleware, so data latency overlaps the render instead
of serializing after it, and client components read them with `useLoader()`:

```tsx
export const StockLoader = createLoader(async (ctx) => {
  "use server";
  return ctx.env.DB.stockFor(ctx.params.slug);
});

// in a client component
const { data, isLoading } = useLoader(StockLoader);
```

Skeletons are a per-segment choice, not the default first impression. On a
document request, a segment without `loading()` waits for its loaders — the
HTML arrives with data in place, a ready page. Declaring `loading()` (or
your own Suspense boundary) opts that segment into skeleton-then-stream, and
a per-request `ssr.resolveStreaming` resolver can force fully-settled HTML
(`"allReady"`) for bots and crawlers.

Three properties define the live lane.

**Live by default, even inside caches.** A loader resolves fresh on every
request — including cache and prerender hits — which makes the
partial-prerendering shape the _default outcome_, not an incantation:

```tsx
cache({ ttl: 600 }, () => [
  path("/products", ProductsPage, { name: "products" }, () => [
    loader(StockLoader), // never cached: re-runs on every hit
  ]),
]);
```

A cache hit streams the stored UI instantly while `StockLoader` resolves
fresh alongside it. Caching a loader's data is a separate, explicit opt-in
(`loader(Fn, () => [cache({ ttl })])`). The guards are correctness-first:
`cookies()` and `headers()` throw inside cache scopes rather than silently
baking one visitor's data into a shared shell.

**Fetchable on demand.** `createLoader(fn, true)` makes a loader callable
from any client component via `useFetchLoader()` / `load()` — typed params,
optional request bodies, per-loader middleware guarding the fetch endpoint.
No route registration and no `/api` mirror to maintain: fetchable loaders
are discovered at build time, so importing one into the client component
that calls it is enough. Search-as-you-type, pagination, polling — without
hand-rolling an endpoint per interaction.

**They carry RSC, not just JSON.** Loader values serialize through Flight,
so a loader can return ReactNode — server-rendered content, lazy-loaded
exactly when the client asks for it, and cacheable with the same opt-in:

```tsx
export const ReviewsPanel = createLoader(async (ctx) => {
  "use server";
  const reviews = await db.reviewsFor(ctx.params.slug);
  return <ReviewList reviews={reviews} />; // RSC, streamed to the client
}, true);

// client: pull server-rendered content in when the tab opens
const { data: panel, load } = useFetchLoader(ReviewsPanel);
```

That closes a gap RSC frameworks usually leave to bespoke endpoints or
full-route navigation: fetching a server-rendered fragment on interaction —
a tab panel, a modal body, a chart — dynamic when it should be, cached when
it can be.

## Metadata where your data is

`generateMetadata` runs as a separate export and pays for its own data
access. Remix's `meta` export gets loader data but makes every leaf rebuild
its parents' tags. In Rango, metadata is a push at the point where the data
already exists:

```tsx
path(
  "/product/:slug",
  async (ctx) => {
    const product = await ctx.use(ProductLoader);
    const meta = ctx.use(Meta);
    meta({ title: product.name });
    meta({ property: "og:image", content: product.image });
    return <ProductPage product={product} />;
  },
  { name: "product" },
);
```

Segments layer: a layout sets
`meta({ title: { template: "%s | Acme", default: "Acme" } })`, the route
pushes `title: product.name`, and the collected head reads
"Espresso Cup | Acme". Later segments override earlier ones per key, an
`unset` descriptor removes an inherited tag, and deferred (Promise) values
resolve before collection so async metadata participates in templating like
any other value. On soft navigation the previous title holds until the new
one resolves — no flash of an intermediate state.

`Meta` is not a special case. It is one instance of the **handle**
primitive — `createHandle()` gives any feature the same contract: push data
from handlers in segment order, define a collect, read it with `useHandle()`
on the client. `Script` (nonced script injection) and `Breadcrumbs` are the
other built-ins; your own accumulate-across-segments needs ride the same
mechanism.

## The shell manifest pattern

Handles are captured when a segment renders and **replayed on every cache or
prerender hit**. That replay is more than head management: it is a typed
channel from the frozen half of a render to the live half. The cached
artifact can describe itself, and loaders — always live — can read that
description.

The canonical case: a prerendered product list with live prices.

```tsx
// handles/products-on-page.ts
export const ProductsOnPage = createHandle<string, string[]>((segments) =>
  segments.flat(),
);

// routes/products.tsx — the list is baked at build time; prices are not
export const ProductList = Prerender(
  async () => [{ category: "espresso" }, { category: "filter" }],
  async (ctx) => {
    const products = await db.productsByCategory(ctx.params.category);
    const track = ctx.use(ProductsOnPage);
    for (const p of products) track(p.id);
    return (
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} <Price id={p.id} />
          </li>
        ))}
      </ul>
    );
  },
);

// loaders/prices.ts — one batched query for exactly the rendered products
export const PriceLoader = createLoader(async (ctx) => {
  "use server";
  await ctx.rendered();
  const ids = ctx.use(ProductsOnPage);
  return db.pricesFor(ids);
});
```

At build time the handler runs once, renders the shell, and pushes the ids it
rendered. At request time the stored payload replays — handler code never
executes — the handle data lands in the store, and `PriceLoader` reads it to
fetch prices for exactly those products in one query. `<Price>` is a client
component reading `useLoader(PriceLoader)`.

Two properties make this better than the usual cached-shell-plus-holes setup:

- **The holes can never desync from the shell.** A loader that queried
  "current top products" would drift from a stale shell — right prices on
  wrong products. Reading the replayed handle means the live data always
  matches what is actually displayed, by construction.
- **The dynamic data is batched.** Per-hole fetching (each price component
  fetching for itself) is the N+1 default in other PPR designs. Here the
  shell's manifest feeds one route-level loader.

The same pattern works with runtime `cache()` instead of `Prerender` — replay
is the same mechanism. One deliberate cost: a loader that awaits
`ctx.rendered()` runs after the shell resolves rather than in parallel. On
hits — the common case for a cached list — the shell replays immediately, so
the wait is negligible; the serialization is the contract, not a bug. The
full recipe, contract, and testing story live in the
[`/shell-manifest` skill](../skills/shell-manifest/SKILL.md).

## Navigations that are instant and safe

A fully-prefetched navigation commits with no loading flash: if the prefetch
stream drained and decoded cleanly, the router renders the resolved payload
synchronously instead of suspending into skeletons.

```tsx
<Link to={href("/shop/:slug", { slug })} prefetch="viewport">
  {name}
</Link>
```

The interesting part is why turning prefetch up is _safe_. Aggressive
client caching is only as good as its invalidation, and that is where client
routers usually lose user trust. Rango's client cache is invalidated
automatically and coherently:

- Every server action invalidates by default: history entries are marked
  stale (back/forward still paints instantly, then revalidates in the
  background), the prefetch cache flushes, and a rotating `X-Rango-State`
  value — sent on every prefetch and keyed into the browser HTTP cache via
  `Vary` — strands every HTTP-cached payload from before the mutation.
- Sibling tabs are notified, and the state cookie itself is the cross-tab
  sync channel, so a mutation in one tab cannot serve pre-mutation data in
  another.
- The escape hatch is per-invocation, not per-definition. An action that
  turns out to be a no-op keeps the caches warm by saying so:

```ts
export async function addToCart(productId: string) {
  "use server";
  const result = await tryAddToCart(productId);
  if (!result.ok) {
    keepClientCache(); // this invocation mutated nothing — keep prefetches
  }
  return result;
}
```

Forget the call and you merely lose warmth — the default invalidation covers
you. Every failure direction in this subsystem points toward freshness, never
toward staleness.

## Instant loading with server authority

An opt-in `clientUrls()` module lets the hydrated browser recognize a destination
route and show its loading UI before the server response arrives:

```tsx
// catalog.client-urls.tsx
"use client";

import { clientUrls } from "@rangojs/router/client";
import { ProductLoader } from "./product.loader.js";

export default clientUrls(({ path, layout, loader, loading }) => [
  layout(CatalogLayout, () => [
    path("/catalog", CatalogIndex),
    path("/catalog/:productId", ProductPage, () => [
      loader(ProductLoader),
      loading(<ProductLoading />),
    ]),
  ]),
]);

// urls.tsx
import { urls } from "@rangojs/router";
import catalogClientUrls from "./catalog.client-urls.js";

export const urlpatterns = urls(({ include, layout }) => [
  layout(<CatalogRscLayout />, () => [
    include("/catalog", catalogClientUrls, { name: "catalog" }),
  ]),
]);
```

The browser match is not a second authority. It only selects transient
destination loading and `useOutlet().pending` after hydration. The existing
partial Flight request still runs the canonical server matcher, global router
middleware, and the route's `createLoader()` definitions by ID; its response
commits URL, history, and content. Hard requests use the same projected routes
for SSR and hydration.

That narrower contract avoids a second loader cache or navigation protocol, but
it also keeps the initial API deliberately small: named client components,
`path`/`layout`/`loader`/`loading`, `include()` mounting in the canonical
`urls()` tree, and only `name`, `search`, and `trailingSlash` path options.
The include supplies URL/name prefixes and the surrounding RSC layouts,
middleware scope, and boundaries; route-local middleware/revalidation,
parallel/intercept routes, cache, transitions, boundaries, and PPR are not
available INSIDE `clientUrls()`. See the
[client URL guide](./client-urls.md) for the complete limits.

The immediate loading branch can appear before global auth middleware completes.
It must not reveal protected data or sensitive route state; if the shell itself
is sensitive, do not use optimistic loading for that destination.

## Semantics are a contract, not folklore

The execution model — middleware scope, handler-first ordering, context
visibility, partial revalidation, progressive enhancement — is written down
in one document
([execution model](./internal/execution-model.md)) and pinned by a semantic
matrix test suite that runs in both dev and production. Two guarantees
worth calling out:

- **Dev and production resolve every request through the same route trie,
  built by the same builder.** A route cannot match in dev and 404 in
  production; a parity test stands guard.
- **JS and no-JS are the same contract.** A form POST without JavaScript and
  the same action with it must produce matching middleware effects, cookies,
  and rendered state. Divergence is classified as a bug, not a caveat.

## Testing is part of the API surface

Every feature a consumer can touch is reachable through shipped testing
primitives — real handlers, real middleware chains, real Flight
serialization, no framework mocks:

```ts
const { tree, headers } = await renderHandler(ProductPage, {
  params: { slug: "widget" },
  loaders: [[ProductLoader, { name: "Widget" }]],
});
expect(findElements(tree, { tag: "h1" })[0].text).toContain("Widget");
```

`runLoader`, `runMiddleware`, `dispatch`, `renderRoute`, and the Flight
renderers cover the tiers below e2e; the repo's own rule is that if a feature
cannot be tested through these primitives, the primitive gets extended in the
same PR. What we use to test the router is what you get to test your app.

## What it costs

Candor about the trade-offs, since the pitch above is only credible with
them:

- **You write the tree.** There is no file convention to scaffold routes for
  you. The tree is the point — but it is authored, not inferred.
- **Some vocabulary is new.** Handles, the two freshness axes, and
  `revalidate()`-as-selection (not cache expiry) take a session to
  internalize, precisely because other frameworks use the same words for
  different things. The [skills](../skills/rango/SKILL.md) exist to make
  that session short.
- **Client URL loading is optimistic, not authorization.** Its loading branch can
  render before global middleware finishes, and the Phase 1 DSL intentionally
  omits composition, route middleware/revalidation, boundaries, cache, and PPR.
- **The router is experimental.** The semantics are pinned and tested, and
  the API is converging, but pre-1.0 means pre-1.0.

If you want a router where the behavior you get is the behavior you can read
— in your own route tree, in a contract document, and in the tests that pin
it — that is the trade Rango makes everywhere.
