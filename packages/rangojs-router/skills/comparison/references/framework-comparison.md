# Rango compared to Next.js, TanStack Start, and Waku

If you are choosing a React framework and trying to place Rango on the map, start
here. This doc compares Rango against the three frameworks people most often weigh
it against, and it compares them on **capabilities and design** — the things that
stay true regardless of how old each project is. Where another framework leads
(ecosystem, integrations, hiring pool), this doc says so plainly; a comparison
that only lists wins is not useful to anyone making a real decision.

A note on naming: identifiers below (`urls()`, `revalidate()`, `createLoader`,
`prefetch`, `debugPerformance`, the `rango.*` spans, …) are the actual public API,
so you can grep for them. Numbers (bundle sizes, gating timeouts) are the measured
or coded values, not estimates.

## Contents

- [TL;DR](#tldr) and [at a glance](#at-a-glance)
- [Where Rango's design leads](#where-rangos-design-leads)
- [Runtime mechanics in depth](#runtime-mechanics-in-depth)
- [The loader as a new primitive](#the-loader-is-a-genuinely-new-primitive)
- [Tainted request context](#tainted-request-context-cache-safety-is-integrated)
- [Performance diagnostics](#performance-diagnostics-debugperformance)
- [Framework-specific perspective](#coming-from-a-specific-framework)
- [Where the others still lead](#where-the-others-still-lead)
- [Bottom line](#bottom-line)

## TL;DR

Rango is **RSC-first on Vite** (like Waku) but **batteries-included** (like
Next.js), with **type-safe, code-defined routing** (competing with TanStack
Start), a **composable graph of named render slots**, and a **single unified
caching/prerender model**. It is the only one of the four that combines
programmable RSC partial rendering, request-aware prefetch correctness, tainted
request-context guards, portable deployment-skew recovery, a server-phase
performance waterfall, and a public RSC/server testing harness. Its **loader** is
a genuinely new primitive rather than a renamed Remix/TanStack loader (see
[The loader is a genuinely new primitive](#the-loader-is-a-genuinely-new-primitive)).

The practical advantage is range: a Rango application can begin as one route and
one component, then gain type-safe links, live data, caching, partial rendering,
and multi-region composition without replacing its routing or data model.

## At a glance

| Dimension               | **Rango**                                                                                                  | Next.js (App Router)                                                           | TanStack Start                                                                     | Waku                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Routing model           | Code DSL (`urls()`/`include()`), named + `reverse()`                                                       | File-system convention                                                         | File or code, type-first                                                           | File-system (+ `createPages`)                                           |
| Foundation              | Vite + plugin-rsc                                                                                          | Turbopack/Webpack                                                              | [Vite or Rsbuild](https://tanstack.com/start/latest/docs/framework/react/overview) | Vite + plugin-rsc                                                       |
| RSC model               | RSC-first                                                                                                  | RSC-first                                                                      | SSR/client-first; RSC opt-in                                                       | RSC-first                                                               |
| Type-safe routes/params | Generated names, params, search, `reverse()`, response MIME                                                | Stable typed links; route-local param types                                    | Best-in-class                                                                      | Typed path params                                                       |
| Client render selection | Per-segment/loader `revalidate()` policy; typed action and result matching                                 | Automatic segment reuse; refresh/invalidation APIs                             | Match/loader reload policy                                                         | Route refetch/reload                                                    |
| Slots and intercepts    | Code-defined named slots with their own loaders/policy; conditional alternate soft-navigation compositions | File-system `@slot` + intercept conventions                                    | Route masking, no parallel RSC slot graph                                          | No equivalent route-slot graph                                          |
| Caching                 | One segment store = runtime + build-time + `"use cache"`, tags, SWR                                        | Cache Components plus distinct server/client cache lifecycles                  | Router loader cache + Query integration + HTTP/CDN policy                          | Minimal                                                                 |
| Request/cache safety    | Tainted request contexts, non-cacheable typed vars, guarded effects                                        | Runtime APIs isolated from `"use cache"`; optional React client-boundary taint | Application policy                                                                 | Application policy                                                      |
| Prerender               | Build-time cache; worker serves every request; per-param `Passthrough()`                                   | SSG/ISR + Cache Components/PPR                                                 | Static prerender + HTTP/CDN ISR patterns                                           | Static prerender                                                        |
| No-JS parity            | First-class, tested (semantic matrix)                                                                      | Forms/Server Actions supported; no parity harness                              | Server functions support forms; no parity harness                                  | Server Actions/forms; no parity harness                                 |
| Middleware              | Global + segment-scoped subtree                                                                            | Single request Proxy; no segment subtree scope                                 | Request/server-function middleware                                                 | [Hono middleware + handler interceptors](https://waku.gg/#interceptors) |
| Observability           | Built-in CF + Vercel OTel phase spans, `Server-Timing`, perf waterfall                                     | Built-in OTel spans; no equivalent router-phase waterfall                      | Client/data devtools                                                               | No equivalent built-in phase model                                      |
| Deploy targets          | Node, Cloudflare, Vercel — all with presets                                                                | Node/Vercel first; other platforms through adapters                            | Broad Vite/Rsbuild runtime support                                                 | Node plus adapters                                                      |
| Deployment skew         | Automatic build-version handshake for navigation, prefetch, and actions; safe reload on mismatch           | `deploymentId` mismatch reload; Vercel can pin clients to an immutable deploy  | Application/platform policy                                                        | Application/platform policy                                             |
| Multi-tenant            | `createHostRouter()` built-in                                                                              | Roll your own                                                                  | Roll your own                                                                      | Roll your own                                                           |
| Testing primitives      | Ships `@rangojs/router/testing` (handlers/loaders/mw/Flight/e2e)                                           | No comparable handler/Flight primitives                                        | Router test utils                                                                  | No comparable handler/Flight primitives                                 |
| Client runtime          | ~50 KB Rango + ~115 KB React/RSC, per-route chunks                                                         | Configuration-dependent                                                        | Configuration-dependent                                                            | Deliberately light                                                      |
| Ecosystem               | Smaller                                                                                                    | Largest                                                                        | Growing                                                                            | Small                                                                   |

The rest of this doc unpacks the rows where the design difference is substantive.

## Where Rango's design leads

### Start simple; grow without changing models

Rango's advanced features are not setup requirements. The smallest useful app is
still a route tree and a component:

```tsx
const router = createRouter().routes(({ path }) => [
  path("/", HomePage, { name: "home" }),
]);
```

As the application grows, each requirement adds one local primitive to that same
tree:

| When you need to…                          | Add…                              |
| ------------------------------------------ | --------------------------------- |
| make navigation refactor-safe              | a route `name` and `reverse()`    |
| split the application into modules         | `urls()` and `include()`          |
| keep request data live beneath cached UI   | `loader()`                        |
| cache or prerender a shared shell          | `cache()` or `Prerender()`        |
| choose what updates after an action        | `revalidate()`                    |
| render independent regions                 | `parallel()` and named slots      |
| open a route as a modal on soft navigation | `intercept()`                     |
| inspect where request time went            | `debugPerformance` or `telemetry` |

Nothing in the first route requires learning the last row. More importantly, the
last row does not force a migration to a second router, client data library, or
static-versus-dynamic application mode. The source-visible route tree remains the
organizing model from the first page to the complex application.

### AI makes a coherent growth path more valuable

AI-assisted development lowers the cost of adding a feature; it does not lower the
cost of understanding how routing, data, caching, rendering, and invalidation
interact afterward. A tool that is pleasant for the first generated page but needs
several unrelated systems as the application grows gives both the developer and the
agent a fragmented model to reason about.

Rango is useful to one developer out of the box, then scales by adding declarations
to the same route graph. An agent can inspect `urls()` to find route ownership and
shared policy, follow generated names instead of guessing paths, and use the shipped
testing primitives and performance timeline as machine-verifiable feedback. Adding
authentication, live data, a cached shell, a modal route, or targeted post-action
updates extends the existing model rather than introducing another router, data
library, cache vocabulary, or observability layer.

That does not make application complexity disappear. It keeps the complexity
explicit, colocated, and testable—the properties that matter when code can be
produced faster than a person can manually reconstruct its architecture.

### Routes are expressed, and behavior composes around them

Rango makes the route graph readable from source. You do not have to reconstruct
it from directory topology or infer behavior from a collection of specially named
route, layout, loading, error, and middleware files. Reading a `urls()` tree from
top to bottom shows which URLs exist, which handlers own them, how modules mount,
and where shared concerns apply.

This does not mean keeping the application in one file. Route handlers, layouts,
and reusable policy can live in separate modules; `include()` makes those module
boundaries explicit. The distinction is that the composition returns to one
declared tree. Middleware, loaders, caching, loading/error policy, revalidation,
parallel slots, and intercepts appear beside the structure they affect instead of
being implied by file placement.

Rango separates **structure** from **configuration**. `path()` and `include()`
define which URLs exist, so they stay visible in the `urls()` tree. Middleware,
loaders, caching, loading/error policy, revalidation, parallels, and intercepts
configure a node, so they can be imported or composed through small factories:

```tsx
const withAccountPolicy = () => [
  middleware(requireUser),
  revalidate((ctx) => ctx.isAction(AccountActions) || undefined),
];

const accountPatterns = urls(({ path }) => [
  path("/orders/:id", OrderPage, { name: "order" }, () => [
    withAccountPolicy(),
    loader(OrderLoader),
  ]),
]);

urls(({ include }) => [
  include("/account", accountPatterns, { name: "account" }),
]);
```

The composition site still answers which URLs exist and who owns them. The
included module keeps local names while the mount creates stable scoped identities
such as `account.order`. Consumers navigate by those identities:

```ts
ctx.reverse("account.order", { id: order.id });
```

Moving the route to a different path does not require updating every caller.
Generated route maps carry required/optional params, search schemas, route names,
loader returns, and response-route MIME payloads through server and client APIs.
The same tree can expose typed `path.json()`, `.text()`, `.html()`, `.xml()`,
`.image()`, `.stream()`, and `.any()` endpoints, including content negotiation,
SSE, and WebSocket upgrades, without introducing a second API-routing model.

Next.js now has stable typed links, but the URL and composition hierarchy remain
filesystem identities. TanStack Router is the strongest peer on inferred route and
search-param types; Rango's distinction is Django-style named reversal and module
mounting in an RSC server route tree. Waku types path parameters but exposes a much
smaller route-identity surface. See the [Rango overview](../../rango/SKILL.md).

### One caching model, and prerender is part of it

This is the largest architectural difference from Next.js. Rango unifies three
things under one `SegmentCacheStore` abstraction: the runtime segment cache
(`cache({ ttl, swr, tags })`), the `"use cache"` directive, and **pre-rendering**.
They share one mental model, one tag-invalidation API (`cacheTag` / `revalidateTag`
/ `updateTag`), and one SWR behavior.

The guiding principle is that **pre-rendering is just build-time caching**. There
are no static `.html`/`.rsc` files served from a CDN bucket — the worker handles
every request and either replays a stored Flight payload (a cache or prerender
hit) or renders live. The browser cannot tell which happened.

Next.js's
[Cache Components](https://nextjs.org/docs/app/getting-started/cache-components)
model is powerful, but server data/output lifetimes and the client router cache
still have distinct rules. TanStack Router has its own loader cache and integrates
deeply with Query when an application wants a richer data cache; HTTP/CDN policy
remains another layer. Waku keeps caching minimal. Rango's bet is that one model
for "cached, `use cache`, and prerendered" is easier to hold in your head than
several cooperating caches.

### `Passthrough()`: prerender the common case, live-render the rest

A prerender handler can decide, **per param set**, whether to bake an artifact or
defer: `return ctx.passthrough()` falls through to the live handler at runtime. So
you statically generate your top 1,000 products and serve the long tail
dynamically, from one definition. Next.js approximates this with
`generateStaticParams` + `dynamicParams`, but that is two separate knobs rather
than one decision point inside your handler. See
[prerender-api-design.md](../../../docs/prerender-api-design.md).

### Progressive enhancement is a tested contract

Forms and server actions work with JavaScript disabled: a form POST runs the
action on the server, re-renders the affected segments, and returns HTML. The
JS and no-JS paths are held to a parity contract that is **encoded as a test** —
the semantic matrix (`e2e/semantic-matrix.test.ts`) pins middleware scope,
handler-first ordering, context visibility, and PE/JS parity. The other frameworks
have progressively enhanced form or server-function paths in different forms; the
distinction is that Rango ships parity helpers and keeps the contract under an
explicit semantic matrix rather than leaving parity to each application.

### CSP nonce plumbing is integrated

Strict Content Security Policy often fails at framework-owned inline scripts: the
application can generate a nonce, but every SSR, hydration, and streaming path has
to carry it consistently. Rango makes that propagation part of the request model.
Set `nonce: () => true` to generate a fresh cryptographic nonce per request, or
return an application-provided value from `nonce(request, env)`.

The resolved nonce is applied to the inline scripts that carry the RSC payload into
the HTML stream and is available during SSR through `useNonce()`. Document-rendered
scripts pushed through the typed `Script` handle receive it automatically. For
custom policy middleware, the same value is available as a typed context token:

```tsx
import { nonce, type Middleware } from "@rangojs/router";

const csp: Middleware = async (ctx, next) => {
  await next();
  const value = ctx.get(nonce);
  if (value && ctx.headers.get("content-type")?.includes("text/html")) {
    ctx.header(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self' 'nonce-${value}' 'strict-dynamic'`,
    );
  }
};
```

Rango deliberately does not serialize the nonce into the hydrated browser, where
exposing it would weaken the policy. Consequently, an async script first discovered
on a soft navigation is client-injected without a nonce; use the recommended
`'strict-dynamic'` policy or allow its host. The application still owns the CSP
directives and reporting policy. What Rango supplies is the easy-to-miss framework
plumbing, including a CSP example and e2e coverage for hydration, navigation, and
Server Actions.

### Framework mutation channels have default CSRF protection

`originCheck` is enabled by default. Before executing a Server Action, fetchable
loader request, or progressively enhanced form submission, Rango compares the
browser's `Origin` header—or `Referer` as a fallback—with the request protocol and
`Host`. A mismatch, `Origin: null`, or an origin-bearing request with no trustworthy
`Host` fails closed with `403`. The rejection also reaches `onError` and telemetry
as an origin-check event.

The default deliberately ignores `X-Forwarded-Host` and `X-Forwarded-Proto`; those
headers are unsafe unless a trusted proxy strips user-provided values. Applications
behind a non-standard proxy can provide an `originCheck(ctx)` callback with access
to the request, environment, router id, request phase, and `defaultCheck()`. The
callback can allow, reject, or return a custom `Response`; `originCheck: false` is
the explicit opt-out.

This is framework-level CSRF protection, not a universal synchronizer-token system.
Requests with neither `Origin` nor `Referer` remain available to non-browser clients,
and ordinary response routes or custom API handlers are outside this automatic gate.
Protect those endpoints with authentication, route middleware, and a token or custom
origin policy when their threat model requires it. The useful default is that
Rango's own mutation transports do not begin unguarded, and the JS and no-JS form
paths pass through the same check.

### A deterministic execution model

The router gives you guarantees most file-based routers leave implicit:

- **Handler-first ordering** — a route's handler runs before its child layouts,
  orphan layouts, and parallel slots in the same render pass, so a handler can set
  context that children read.
- **Two clear middleware scopes** — request-level (`router.use()`) versus
  **segment-scoped subtree** middleware, which is more granular than Next's single
  root [`proxy.ts`](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
  request boundary.
- **Structural context visibility** — `ctx.set()`/`ctx.get()` flow down the tree
  only; parallel siblings do not bleed into each other.
- **Dev/prod matching parity** — one trie is used in both dev and production, so
  matching cannot drift between them. See
  [matching-and-lazy-discovery.md](../../../docs/internal/matching-and-lazy-discovery.md)
  and [execution-model.md](../../../docs/internal/execution-model.md).

### Observability you do not wire yourself

`createCloudflareTracing()` and `createVercelTracing()` emit nested phase spans out
of the box — `rango.request`, `rango.middleware`, `rango.action`, `rango.loader`,
`rango.handler`, `rango.render`, `rango.ssr` — that nest under the platform's own
KV/D1/fetch spans. The same instrumentation site also powers `debugPerformance`
(see [the diagnostics section](#performance-diagnostics-debugperformance) below).
Next.js also ships automatic OTel instrumentation; Rango's distinction is that the
same router-owned phase registry drives its traces, local waterfall, and
`Server-Timing` output. TanStack's strength is client/data devtools; Waku does not
ship an equivalent request-phase model. See
[telemetry.md](../../../docs/telemetry.md).

### Deploy to Node, Cloudflare, and Vercel — and host many apps behind one entry

Three presets, each with its own cache store: `CFCacheStore` (Cloudflare KV, L1+L2),
`VercelCacheStore` (Vercel Runtime Cache, Node runtime), and
`MemorySegmentCacheStore`. Next.js deployments beyond its Node/Vercel path depend
on platform adapters such as OpenNext. Rango owns both its Cloudflare and Vercel
presets and was designed for the edge-worker model from the start.

On top of that, `createHostRouter()` routes by domain/subdomain to independent
sub-apps (each its own `createRouter()` with its own route map and cache store),
lazy-loaded by dynamic import. The optional `defineHosts()` helper freezes a named
map of reusable host patterns and preserves its exact TypeScript keys; it does not
perform routing itself. None of the other three offer multi-tenancy as a
first-class primitive.

### Deployment skew is detected before stale code executes

The Vite plugin generates a build version and injects it into the RSC handler and
initial payload. The browser returns that version on every partial navigation,
prefetch, and Server Action. If an old tab reaches a newer server, request
classification detects the mismatch before resolving the route or executing the
action and responds with `X-RSC-Reload`. The browser then performs a clean document
navigation instead of trying to decode new Flight with an old client or invoking a
stale action identifier. Even a route removed by the new build reloads rather than
falling through to a misleading 404.

The protection covers fresh, completed-prefetch, and in-flight-prefetch responses.
For action requests, the reload returns to the same-origin referrer rather than the
internal action URL. The cache side follows the same correctness rule:
`CFCacheStore` automatically versions its physical Cache API and KV keys, so a new
build cannot replay Flight containing an old component shape or dead client-chunk
reference. `VercelCacheStore` exposes the same version segmentation and recommends a
deployment-specific Runtime Cache namespace. The browser's Rango state also includes
the build version, rotating HTTP and in-memory prefetch cache identity on boot.

Next.js deserves explicit credit here: its
[`deploymentId`](https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId)
also detects navigation skew and forces a hard navigation, while
[Vercel Skew Protection](https://vercel.com/docs/skew-protection) can route an old
client back to its original immutable deployment. Rango's distinction is an
automatic, framework-owned handshake across its Node, Cloudflare, and Vercel
presets, integrated with RSC navigation, prefetch, actions, and its cache model.
Rango's recovery is reload-based; it does not claim Vercel's stronger
old-deployment request pinning.

### A shipped testing harness for server code

`@rangojs/router/testing` gives you `runLoader`, `runMiddleware`, `dispatch`,
`renderHandler`, `renderRoute`, real Flight rendering (`renderServerTree`,
`findClientBoundaries`, `findElements`), and a Playwright e2e harness with dev/prod
parity helpers (`parityDescribe`, `expectParity`). You can unit-test a loader, a
middleware, or an RSC handler in isolation. Next.js and Waku ship no official
primitives for testing server components/handlers; TanStack has router test utils
but nothing at the RSC-handler level. See
[testing.md](../../../docs/testing.md).

### Bundle discipline

The Rango client runtime baseline is ~50 KB gzip; the React + RSC client baseline
is ~115 KB gzip (react-dom 96K + react 5K + rsd-webpack-client 12K + scheduler 3K).
Per-route client chunks are the default (`clientChunks`), and a build guard fails
the build if React's development bundle leaks into production. Treat those as
Rango baselines, not a normalized cross-framework benchmark: application shape,
React version, compiler output, and deployment transforms make headline bundle
comparisons unreliable. Waku deliberately targets a smaller surface. See
[client-chunking.md](../../../docs/client-chunking.md).

## Runtime mechanics in depth

The sections above are architecture. The sections below are the runtime mechanics
where Rango exposes unusually fine control.

### Partial rendering (segment diffing)

Every `layout()`, route, `loading()` skeleton, and `parallel()` slot is its own
_segment_ with a server-assigned stable `id`. On navigation the server returns
`metadata.isPartial`, `metadata.matched[]` (all destination segments), and
`metadata.diff[]` (only the segments that changed). The client:

- **`diff` empty** — commits cached segments with no re-render. DOM, component
  instances, scroll, and local state are preserved exactly.
- **`diff` non-empty** — swaps only the changed segments, keyed by the stable `id`
  so React reconciles instead of remounting. Unchanged ancestors and the other
  parallel slots come from cache untouched.
- **fallback** — a non-partial response triggers a full document re-render.

Next.js's App Router also does segment-aware partial rendering; the difference is
that Rango's diff is explicit and inspectable, is coupled to the `revalidate()`
control surface below, and the same path serves the no-JS render. TanStack does
fine-grained nested re-rendering but client-side, not as RSC Flight diffs; Waku's
RSC refetch is coarser.

### Named slots: composition is part of the render model

Nested routes give you one outlet. Real applications usually have more than one
independently changing region: main content, navigation, cart, notifications,
metadata, and modal surfaces. Rango makes those regions named server-rendered
slots rather than layout props assembled by hand:

```tsx
function ShopLayout() {
  return (
    <>
      <ParallelOutlet name="@banner" />
      <ParallelOutlet name="@sidebar" />
      <Outlet />
      <ParallelOutlet name="@modal" />
    </>
  );
}

layout(<ShopLayout />, () => [
  parallel({
    "@banner": CampaignBanner,
    "@sidebar": ProductFilters,
  }),
  path("/products", ProductList, { name: "products" }),
]);
```

The layout owns placement; the route composition owns what fills each slot. A
slot handler can carry reusable defaults through `handler.use`: loaders,
`loading()`, revalidation, and error/not-found boundaries.
The mount can broadcast configuration to all slots or refine one slot with a
slot-local descriptor. Merge order is explicit: handler defaults, shared mount
configuration, then slot-local configuration.

With `loading()`, a parallel slot is an independent streaming unit: its loader
can resolve behind its own skeleton without blocking the default outlet, parent
layout, or sibling slots. Without `loading()`, its loader deliberately blocks the
parent when that data is required before paint. Handler-first ordering also means
the slot can read context produced by its owning route or layout in the same full
render pass.

Slots are composition points, not just concurrency syntax. The last definition of
a given slot name wins while unrelated earlier slots remain, so an application can
provide defaults and a narrower feature composition can replace only `@sidebar`.
A UI-less slot can push typed handles such as metadata, scripts, or breadcrumbs,
keeping render output extensible without coupling it to the main handler.

Next.js has capable parallel routes, but `@folder`, `default.tsx`, intercept
markers, and layout props encode them in filesystem topology. Rango exposes the
same class of UI as code-level values with handler defaults, per-mount policy,
streaming control, and deterministic override semantics. TanStack route masking
can model modal URLs but does not create a parallel RSC slot graph; Waku slices are
[reusable components with their own static or dynamic render mode](https://waku.gg/#slices),
not route-owned slots with independent revalidation. See the
[parallel route guide](../../parallel/SKILL.md).

### Intercepts: alternate compositions for the same canonical route

An intercept says that a named target route should render a different composition
into a slot during eligible soft navigation:

```tsx
layout(<ShopLayout />, () => [
  intercept("@modal", "product.detail", ProductQuickView, () => [
    when(({ from }) => from.pathname === "/products"),
    loader(ProductLoader),
    loading(<QuickViewSkeleton />),
    middleware(trackQuickView),
  ]),
  path("/products/:slug", ProductPage, { name: "product.detail" }),
]);
```

A click from the list renders `ProductQuickView` into `@modal` and preserves the
list behind it. A direct visit or reload renders the canonical full page. Back
closes the modal and restores the preserved background. The intercept can own its
middleware, layout, loaders, loading/error policy, loader-level caching, and
`revalidate()` rules; `when()` can choose by navigation source.

This is integrated with the rest of the runtime rather than implemented as URL
masking plus local component state. Intercepts get source-scoped prefetch entries
so a modal Flight payload cannot leak into direct navigation. A prerendered target
can store a separate intercept variant while its loaders still run live at
request time. An action can revalidate the open intercept without remounting its
subtree or forcing the preserved background to render. See the
[intercept guide](../../intercept/SKILL.md).

### `revalidate()`: declarative control over what re-renders

There are two distinct things named "revalidate", and the split is deliberate:

1. **`revalidate(fn)` DSL predicate** — attached per segment (route, layout,
   parallel, loader). It receives a rich arg object including `currentParams`,
   `nextParams`, `currentUrl`, `nextUrl`, `defaultShouldRevalidate`, `segmentType`,
   `actionId`, **`isAction(...refs)`** (typed, rename-safe action matching — you
   pass the imported action, not a string), `actionResult`, `formData`, `method`,
   and `stale`. Return `true`/`false` to re-render or keep the client's current
   segment, or `{ defaultShouldRevalidate }` to change the suggestion seen by
   downstream revalidators in the same decision chain. This is surgical
   post-action control: "this widget re-renders only when `addToCart` ran; the
   rest of the tree stays put."
   See [is-action-api-design.md](../../../docs/design/is-action-api-design.md).
2. **`revalidate: false` on `<Link>` / `navigate()`** — shallow navigation. When
   the pathname is unchanged (a search or hash change), it updates the URL and all
   location hooks but skips the server fetch and re-render entirely. For filters,
   tabs, and pagination. See
   [shallow-navigation.md](../../../docs/shallow-navigation.md).

Both are separate from `revalidateTag()`/`updateTag()`, which hard-purge tagged
cache entries. `updateTag()` is awaitable for read-your-own-writes;
`revalidateTag()` schedules the same invalidation in the background. Neither API
selects a client segment to render. Next.js offers `router.refresh()` plus path/tag
cache invalidation, but no per-segment render predicate and no typed action
discrimination. TanStack's `shouldReload`/`router.invalidate()` is the nearest
analog but operates on loader/query reload, not RSC-segment render.

### Prefetching: stability and control

`<Link prefetch="hover|viewport|render|adaptive|none">` (default `"none"`), plus
`prefetchKey` (`":source"` scopes a prefetch to the originating page for routes
whose response branches on `currentUrl`). The distinguishing part is the stability
gating: a queued prefetch (`viewport`/`render`) will not fire until **both** the
main thread is idle (`requestIdleCallback`, 200ms fallback) **and**
`waitForViewportImages()` resolves — in-viewport images that are not `.complete`
have loaded — or a 2s hard cap elapses. This keeps speculative fetches out of the
connection pool while critical above-the-fold images are still pending, without
letting a slow image stall prefetch indefinitely.

Other guarantees: a completed prefetch payload is eagerly decoded — importing its
client references before the click — and **reused verbatim on the real navigation**.
Navigation can adopt a still-in-flight destination prefetch instead of issuing a
duplicate request; it cancels queued work and aborts unrelated executing work.
Fetches run at `priority: "low"`, all prefetch paths have a 30s stall ceiling, and
the bounded cache uses a configurable TTL. `Save-Data`,
`prefers-reduced-data`, or `prefetchCacheTTL: false` disable speculation.

Correctness is part of the prefetch contract. Keys include Rango state, destination
URL, and the mounted segment set used to compute the diff. Server actions rotate
state and abort stale speculative work; a generation check prevents a late result
from repopulating an invalidated cache. Intercepts are automatically source-scoped,
and malformed, cross-origin, foreign-router, redirect, and reload responses are
dropped rather than warmed. `useLinkStatus()` exposes `{ pending }` for the owning
link.

**Rango State ties prefetch and client-cache invalidation together.** It is a
session-cookie value shaped as `{buildVersion}:{invalidationTimestamp}`. Navigation
and prefetch requests send it as `X-Rango-State`, and RSC responses vary on that
header, so the browser HTTP cache and Rango's decoded prefetch map share one cache
identity. A deployment changes the version; a mutation rotates the timestamp. Old
responses become unreachable under the retired identity instead of requiring every
cache layer to delete the same entries successfully.

Userland controls that rotation through `invalidateClientCache()`, imported from
`@rangojs/router` on either side of the RSC boundary. In the browser it immediately
marks history entries stale, flushes prefetches, rotates Rango State, and broadcasts
when cross-tab sync is enabled. Back/forward can still paint its cached entry and
then revalidate, giving stale-while-revalidate behavior instead of a destructive
clear. On the server, the same function rotates the responding client's state
cookie. Across those two seats, it covers mutations initiated outside the action
bridge: REST calls, client-observed WebSocket events, authentication changes, or
middleware/loader decisions.

Server Actions invalidate automatically after a response reaches the browser. If
an action knows it changed nothing that any route renders, `keepClientCache()` is
the explicit per-response escape hatch: it suppresses that automatic state
rotation, prefetch flush, broadcast, and revalidation fetch. Together,
`invalidateClientCache()` and `keepClientCache()` give application code control in
both directions — force a miss for mutations the router cannot observe, or preserve
the current state for a known no-op.

TanStack Router is the real peer here (`preload="intent|viewport|render"`,
`preloadDelay`, `preloadStaleTime`); Rango's edge is the resource-aware
idle + image-ready gating and RSC-payload reuse. Next has an internal prefetch
scheduler, but its public `<Link prefetch>` surface does not expose Rango's choice
of trigger and resource gates. Waku exposes manual route prefetching without this
policy layer.

### Loaders, and tagged loading

`createLoader(fn)` / `loader()` define **live-by-default** data units: they are
excluded from an enclosing segment cache and resolve on every request unless the
loader itself explicitly opts into `cache()`. They may safely read `cookies()`,
`headers()`, request context, and `env` because loader execution is outside the
cached shell. Loaders run in parallel, stream independently under `loading()`
boundaries, compose server-side via `ctx.use(OtherLoader)`, and can
`await ctx.rendered()` to read handle data after the render settles. Reads happen
through `useLoader` in a client component (including its SSR pass) or
`useFetchLoader` for standalone client fetches. "Fetchable" loaders are callable
endpoints with their own middleware and GET/POST/PUT/PATCH/DELETE bodies.

One sharp edge is worth stating because the distinction matters: a cached handler
can call `await ctx.use(Loader)`, but if it renders that result inline, it bakes the
request value into the cached parent. That server escape hatch is deliberately not
a safe dynamic-hole renderer. The safe UI path is the registered loader segment
consumed through `useLoader()`.

**Tagged loading** is two orthogonal tags on a read:

- **`key`** — a per-instance bucket (`useLoader(Profile, { key: userId })`) so
  different keys store and refresh independently.
- **`refreshGroup`** — one or more cross-loader tags.
  `const refresh = useRefreshLoaders(); refresh("account")` re-runs every
  currently-mounted read tagged with that group (union + dedupe across groups), as a
  plain GET with no params, body, or mutations, and never render-throws. This
  refreshes a set of _different_ loaders together — profile + orders after an
  account switch — which `key` (single loader) cannot.

This is distinct from cache tags (`revalidateTag`). TanStack Start is the genuine
peer on loaders (route loaders + Query-key invalidation as the `refreshGroup`
analog); Rango's loaders are RSC-native, live-by-default, stream under RSC
`loading()`, and the tag system is built into the router with no separate data
library. Next.js and Waku have no loader primitive — they fetch inside async server
components.

## The loader is a genuinely new primitive

"Loader" is a word Remix and TanStack already use, so it is worth being precise
about why Rango's is a new concept rather than a renamed one.

Every prior loader is one of two things:

- **Loader-before-render** (Remix, React Router, TanStack) — a route-coupled
  function that runs as a data phase _ahead of_ the render, populates a loader
  cache, and gates the route until its data is ready. The loader **is** the data
  path, and the cache is the loader's cache.
- **Fetch-in-component** (Next.js App Router, Waku, plain RSC) — there is no loader;
  the async server component awaits its own data inline. Fetching _is_ rendering.

Rango's loader is a third model, and the difference is a polarity flip. In the
loader-before-render model the loader _feeds_ the cache. In Rango the loader
**punches a hole through** it. The segment tree — layouts, handlers, the whole RSC
shell — is cacheable and prerenderable by default (prerender is literally
build-time caching here). The loader is the one thing that stays live by default
and is excluded from the enclosing segment cache, even inside a `cache()` scope or
a fully prerendered route. Caching loader data is a separate, explicit opt-in on
that loader.

The mechanism is concrete: a prerendered route serves its baked Flight shell from
the store, then `resolveLoadersOnly()` resolves the loaders through their own
freshness policy at request time and merges their segments into that replayed
shell. With the default policy you get a cached/prerendered shell plus live data,
automatically, with no per-route static-vs-dynamic decision. The loader is the
carve-out where liveness re-enters an otherwise-static tree.

That reframes what a loader _is_: not "the route's data dependency" but **the
designated live data slot in a cache-first RSC tree.** Several properties follow
that no loader-before-render has:

- it is the **cache-safety escape hatch** — the only place request-coupled reads
  are allowed inside a cache scope, because it is the part guaranteed to re-run;
- it is **standalone and composable**, not route-coupled — one `createLoader()`
  read by many segments, composed via `ctx.use`, or exposed as a fetchable endpoint;
- it **streams as a hole, not a gate** — concurrent, Suspense-resolved under
  `loading()`, so the shell never blocks on it;
- it is **client-addressable and refreshable** independent of navigation (`key`,
  `refreshGroup`, `useRefreshLoaders`), behaving like a built-in, server-defined
  data cell with zero loader logic in the client bundle;
- it can **read render output** via `await ctx.rendered()` — a loader that depends
  on what the render produced, which a strictly before-render model cannot express.

The fair objections, and why they do not collapse the distinction:

- **TanStack has loaders.** It does, and they are the closest peer — but they are
  loader-before-render: route-match-coupled and participants in the router data
  cache. Rango's loader is the thing that stays live _against_ the enclosing
  render cache, RSC-native, and independently addressable.
- **Next has Partial Prerendering.** PPR is the nearest idea in spirit (static
  shell, dynamic holes) and deserves credit. But PPR's holes are inline
  async-component work gated by `Suspense`, not independently addressable data
  primitives: you cannot register one once, read it from three components,
  refresh its mounted readers as a group, or test it through a loader harness.
  Rango makes the hole a first-class, named, composable, refetchable, cache-safe
  primitive and makes that liveness the default.

The point of the primitive: the hard problem in a cache-first architecture is
"where does freshness live, and how do I keep it from corrupting the cache?" Rango's
answer is one primitive — cache and prerender aggressively, and let loaders be the
live, named, testable, client-refreshable slots that punch through. That is the
sense in which it is new.

## Tainted request context: cache safety is integrated

A cache-first RSC tree is only useful if request-specific data cannot silently
become shared output. Rango brands its handler, request, and response-route context
objects at construction time. The brand is consumed by the cache runtime;
applications do not have to remember to mark every context manually.

For a `"use cache"` function, a tainted context object is not serialized wholesale
into the cache key. Rango instead extracts the safe identity dimensions that make
the call reusable without collisions: host, route name, pathname, params, response
type, and normalized user-facing search params. A shared cached function called
from two hosts, route scopes, param sets, or query variants therefore does not
collapse into one entry just because both calls received a `ctx` object.

The same boundary guards operations whose meaning cannot survive a hit. Direct
`cookies()`/`headers()` reads and request/response mutations such as `ctx.set()`,
`ctx.header()`, status, theme, and location-state writes throw inside
`"use cache"`. If a cached function pushes typed handles through
`ctx.use(Breadcrumbs)` or `ctx.use(Meta)`, Rango captures those pushes on a miss and
replays them into the current request's `HandleStore` on a hit; the return value and
its render-side output stay coherent.

Route-level `cache()` has a related but deliberately different guard. Typed context
variables can declare that their values are request-specific:

```ts
const CurrentUser = createVar<User>({ cache: false });

cache({ ttl: 300 }, () => [
  path("/account", (ctx) => {
    const user = ctx.get(CurrentUser); // throws instead of caching one user
    return <Account user={user} />;
  }),
]);
```

A write can also escalate an otherwise cacheable variable with
`ctx.set(Var, value, { cache: false })`; least-cacheable wins. The guard fires when
that variable is read directly inside the cached segment. It intentionally does
not track derived values after they have been copied into an ordinary value, so the
safe rule remains simple: read request-specific context at the live point of use,
normally a loader, rather than deriving it outside and carrying it into a cached
shell.

This is where the taint and loader designs meet. Loaders are the sanctioned dynamic
holes: they run outside the enclosing segment cache and may read the current
request, while the shared shell remains protected. Next.js also isolates runtime
APIs from ordinary `"use cache"`, and React's optional taint APIs protect values at
the server-to-client serialization boundary. Those are useful but different
contracts; they do not provide Rango's route-aware tainted-argument keying,
non-cacheable typed context variables, handle capture/replay, and loader escape
path as one system. TanStack Start and Waku leave this boundary primarily to
application architecture. See the [cache guide](../../cache-guide/SKILL.md) and
[`"use cache"` design](../../../docs/use-cache-api-design.md).

## Performance diagnostics (`debugPerformance`)

`createRouter({ debugPerformance: true })` — one boolean — turns on a per-request
server-side waterfall. Middleware can instead call `ctx.debugPerformance()` before
`await next()` to diagnose one route, query flag, or internal user without enabling
the full timeline globally. The output is a
`[RSC Perf] METHOD /path (12.34ms)` console table with `start`, `dur`, an indented
phase label, and a 40-cell ASCII timeline showing each phase's position, plus the
same data as a `Server-Timing` response header (so it appears in the browser
DevTools Network → Timing panel). Phases metered include `handler:total`,
per-middleware pre/post own-time, `action:<id>`, `loader:<id>`, `handler:<id>` per
segment, `render:total:<routeName>`, and `ssr:render-html`. Bootstrap handler phases
remain in `Server-Timing` even without the full debug timeline, so ordinary
responses retain a low-level latency baseline.

The distinctive part is that measured router work and distributed tracing share
one phase registry. `observePhase()` co-emits the perf metric and trace span from
one wrap site where both surfaces apply; request totals and middleware pre/post
own-time retain their intentional surface-specific representations. The local and
production views therefore use the same execution vocabulary instead of two sets
of hand-maintained instrumentation. It is best-effort and construction-bound
(never buffers the response; streaming phases settle at stream construction, not
drain). When a phase has neither metric nor tracing enabled, its wrapper is a
direct call with no phase-store allocation.

Next.js has no equivalent flip-a-boolean per-request phase waterfall: its automatic
OTel spans still need an exporter and trace viewer. TanStack's strength is
client/data devtools, a different axis from server request-phase diagnostics. Waku
does not ship an equivalent phase model. See
[telemetry.md](../../../docs/telemetry.md).

## Coming from a specific framework

**From Next.js.** You keep RSC, Server Actions, parallel/intercepting routes, and
prerendering, but trade file-convention plus the historically confusing cache
layers for a code-defined, refactor-safe router and one caching model. You gain
Cloudflare as a first-class target and phase spans for free. You give up the
largest ecosystem and talent pool in the React world — the real cost.

**From TanStack Start.** You get comparable type-safe routing (`reverse()`, typed
params/search, even typed response MIME via `.json()`/`.text()`/`.image()`), plus a
true RSC-first model (zero-bundle server components, Flight) that TanStack's
client-first core added later and opt-in. You give up TanStack's best-in-class
search-param ergonomics and its devtools/Query integration.

**From Waku.** Same RSC-first-on-Vite spirit and light footprint, but Rango is the
batteries-included version: unified caching + prerender, segment-scoped middleware,
observability, host router, typed named routes, and a testing harness, where Waku
stays deliberately minimal. If you have outgrown Waku for a complex production app,
Rango is the natural step up.

## Where the others still lead

- **Ecosystem and hiring (Next.js).** Next dwarfs all three in plugins, tutorials,
  Stack Overflow answers, and developers who already know it. That is a genuine,
  non-technical advantage that often decides framework choice on its own.
- **Search-param ergonomics and client/data devtools (TanStack Start).** TanStack's
  validated, fully-typed search-param state and its Router/Query devtools are the
  gold standard; Rango is strong but TanStack set the bar there.
- **Minimal surface area (Waku).** Rango does not require its advanced features,
  but Waku has fewer framework primitives to learn when an application intends to
  remain small.
- **The DSL has a learning curve.** Code-defined routing is more powerful and
  refactor-safe, but file-based routing is more discoverable for newcomers ("the URL
  is the folder"). That is a real onboarding tradeoff.

## Bottom line

Rango starts comfortably at route-and-component scale. Its advantage becomes more
visible as requirements accumulate: type-safe routing, live data beneath cached
UI, partial updates, named compositions, working no-JS forms, tracing, and testable
server code all extend the same model rather than replacing it. That makes its
ceiling particularly useful for complex, production, multi-runtime applications —
especially edge/Cloudflare or multi-tenant systems — without making that complexity
the entry price. Ecosystem breadth remains the main advantage you trade away when
leaving Next.js.
