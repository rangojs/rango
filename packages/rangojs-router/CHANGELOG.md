# Changelog

## Unreleased

### Fixed: a component that hydrates late renders what the server rendered

On a document load, a component in a `<Suspense>` or `loading()` boundary that
streams in after the rest of the page hydrates with the document's state from
every router hook: pathname, params, search params and segments, an idle
`useNavigation()` and `useAction()`, a `useLinkStatus()` that is not pending, the
handle data the HTML was rendered from, and `undefined` location state. Before,
`usePathname`, `useParams`, `useSearchParams`, `useSegments`, `useNavigation`,
`useLinkStatus` and `useAction` read the live state in that render, so a
navigation or an action started while the page was still streaming made React
report a hydration mismatch and render the boundary on the client.

- Navigation state, params and action state show their live value right after
  the component hydrates.
- Late loader pushes and the entry's location state now reach readers once the
  whole document has streamed and every boundary has hydrated, in one transition;
  a reader re-renders only when its selection changes. Before, each reader took
  them right after its own hydration.
- A navigation that commits while the page is still streaming mounts its page
  with the destination's values from its first render.
- `useHandle` and `useLocationState` no longer use `useSyncExternalStore`.

### Changed: router hooks read only the router store

The router store (the per-router `NavigationStore` and `EventController`, reached
through `NavigationStoreContext`) is now the only source these hooks read, and none
of them reads it during render. What you can notice:

- `useSegments(selector)` applies the selector when the router store changes (a
  navigation or new handle data), as `useNavigation` and `useAction` already do. A
  new selector function on a re-render takes effect at the next change. Before, the
  hook re-read the store during render whenever the selector function changed, and
  an inline selector changes on every render: a component inside a page React was
  still holding could show the next page's path. To derive from a prop, call
  `useSegments()` and derive in render.
- `useLoader`, `useFetchLoader` and `useRefreshLoaders` keep client loader data in
  each router's store instead of one module-level store per browser tab. A reader
  whose `key` changes renders without the new key's shared data until its effect
  delivers it, on the next render. Outside a router, `load()` keeps its result in
  the calling hook and `useRefreshLoaders()` does nothing.
- `<Link>` resolves `prefetch="adaptive"` when it arms or is hovered, and still
  re-arms when the input capability changes. It reads the document origin from the
  router store. A `<Link>` rendered outside a router no longer sets `data-external`
  on an absolute URL to another origin; its click still navigates natively.

### Fixed: a `useActionState` result from a form submitted before hydration survives hydration

Before: a form using `useActionState` that was submitted before the page hydrated
(a slow connection, a cold start) posted natively, and the server rendered the
page with the action's result. Then the client hydrated, `useActionState` started
again from its initial state, and the result disappeared. For a value shown once
(a fresh API token, an invite link) the person never saw it and could not get it
back.

Now: the result is still on screen after hydration. The progressive-enhancement
re-render carries the decoded form state in the document payload
(`RscPayload.formState`, a promise, only for a `useActionState` submit, so a
GET adds no bytes), and the generated browser entry hands it to React:
`hydrateRoot(document, app, formState ? { formState } : undefined)`.

Nothing changes for an app on the generated entry. An app with a custom browser
entry (one that calls `initBrowserApp` and `hydrateRoot` itself) passes the same
option:

```tsx
const { initialPayload } = await initBrowserApp({ rscStream, deps });
// Rejects when the action's state is not Flight-serializable.
const formState = await Promise.resolve(initialPayload.formState).catch(
  () => undefined,
);
hydrateRoot(document, app, formState ? { formState } : undefined);
```

As on the JS path, the state an action returns must be Flight-serializable to
survive hydration. A state that is not (a class instance, a function) still
renders in the HTML with status 200, and the page hydrates and resets the hook
to its initial state, as before this change. One thing is new for that case: the
payload's form state slot rejects, so your `onError` now receives a `rendering`
phase error ("Only plain objects... can be passed to Client Components") for the
POST. Before, the state only reached the server-side HTML render, so nothing
reported it.

What does not change: a normal GET, a POST whose action redirects, and a POST
whose action throws into an `errorBoundary()` render and hydrate as before. A
throw with no boundary re-renders with status 500 and the hook hydrates as
`undefined`, what the server rendered, instead of mismatching and resetting to
its initial state.

### Added: test a form submitted before hydration with `createActionForm` and `serveShellRequest({ form })`

`@rangojs/router/testing/flight` builds the POST a form sends before hydration
and serves it through the production no-JS path, so a unit test can pin what a
person sees after it:

```tsx
const form = createActionForm(makeToken, { id: "actions/token#makeToken" });
const result = await serveShellRequest(router, "/token", { form });
expect(result.formState).toEqual([
  { token: "tok-1" },
  "k0",
  "actions/token#makeToken",
  0,
]);
expect(await result.readPayloadFormState()).toEqual(result.formState);
```

`useActionState: false` builds a plain `<form action={fn}>` POST instead.

### Fixed: `useLoader` no longer makes React log a conditional `use()` in development

A `useLoader` read that mounted while its loader was still streaming, and that a
later navigation rendered with the value already settled (seen on a click to the
page already shown), could make React log in development: "This library called
use() to suspend in a previous render but did not call use() when it finished".
The read called `use()` only on a pending stream. It now calls `use()` on every
read, on a settled value too, which returns at once. Nothing on screen changes,
and production never logged it. Tests that render a `useLoader` reader inside
route context and drive state with `act()` should await `act()`, which
`renderRoute` already does. A read outside route context is unchanged.

### Fixed: a streamed handler that fails renders your errorBoundary() instead of the root error page

Before: a route handler on a route with `loading()` that rejected, or called
`notFound()`, after the response started replaced the whole page with the
router's root error page, even with an `errorBoundary()` or `notFoundBoundary()`
declared for it.

```tsx
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loading(<ProductSkeleton />),
  errorBoundary(() => <ProductError />), // before: ignored when the handler rejects late
  notFoundBoundary(() => <ProductNotFound />),
]);
```

Now: the nearest `errorBoundary()` renders in place of the failing segment, and
`notFound()` renders the nearest `notFoundBoundary()`. Layouts and navigation
stay, on the document load and on a client navigation. It applies to route
handlers and parallel slots (a slot finds its layout's boundary) under
`loading()`, and to intercept slots.

What does not change:

- The HTTP status stays what the stream already carried (200).
- `onError` is called once per failure. An intercept slot under `loading()` now
  also emits the `handler.error` telemetry event, as route handlers and
  parallel slots do.
- A failed render is never cached, so the next request runs the handler again.
  `cache()` skips the write only for the cache scope that holds the failed
  segment; a `ppr` shell and the document cache refuse the whole document. A
  Prerender route still fails the build.
- A `notFound()` from a streamed handler keeps status 200: the status was sent
  with the first flush. The same call before the flush still sets 404.
- With no declared `errorBoundary()` the root error page still replaces the
  whole page, and a `redirect()` thrown from a streamed handler is still not an
  HTTP redirect (issue redirects from middleware, a loader, or a synchronous
  handler return).

### Fixed: a `loading()` boundary on screen is no longer replaced by its fallback when nothing in it is pending

A `loading()` boundary showed its fallback for about 300 ms although nothing
in it was pending. Three cases, all in the browser:

- A layout or parallel slot with `loading()` that was already on screen was
  replaced by its fallback when the visitor clicked a link that was not
  prefetched, after entering the page through a prefetched link (or back and
  forward). It showed for a layout with no loaders, for a layout with
  `loading()` and a loader read by `useLoader`, and for a slot with its own
  loader and `loading()`. After a plain click or a document load it never did.
  It no longer shows.
- A layout with `loading()` and no loaders that is new to the page, reached by
  a plain click, showed its fallback for about 300 ms in production. It no
  longer does. In dev it still shows: a client component the layout renders is
  still importing its module in that first render.
- A form action whose commit `transition({ when })` gated off re-rendered the
  route behind its `loading()` skeleton although the action response carried
  the data. The commit is still urgent and unanimated, and in production the
  skeleton no longer shows. In dev it still shows, for the same reason as
  above.

What does not change: a boundary with pending work (a loader still streaming,
a gated-off navigation or `router.refresh()` whose data is still arriving)
shows its fallback as before, and the server render is unchanged.

### Fixed: a prerender refresh that started before `markStale()` is stored stale ([#1072](https://github.com/rangojs/rango/issues/1072))

`router.prerender()` stamped an entry with the time of the store write. A
render that began before `markStale(tags)` and finished after it was kept as
fresh, holding pre-invalidation content. A page, the marker of a refresh that
hit `notFound()` and a `ctx.passthrough()` decline marker are now stamped
(`meta.storedAt`) with the render's start, so both stores mark them stale and
they keep serving until the next refresh. `createMemoryPrerenderStore` now also
remembers when each tag was last marked per router and marks a write rendered
before that mark. `staleAt` still counts the ttl from the write.

Behaviour note: two refreshes of one page can race. A `remove()` still wins over
a render in flight. A `notFound()` marker from a render that started earlier no
longer wins over a render that started later: that render read newer data, and
its page is kept.

A custom `WritablePrerenderStore` that compares a tag marker with
`meta.storedAt` needs no change; one that marks only the entries it holds at
`markStale()` time should also mark a later write stamped before the mark.

### Added: prerender tags are per router

`router.prerender({ env, ctx }).markStale(["product:1"])` marks only that
router's entries. Routers behind a host router can share one prerender store
(one KV namespace), and a mark on one router does not mark another router's
entries for the same tag, in both shipped stores. `createKVPrerenderStore`
writes markers at `__rango_pr_tag__/{encoded routerId}/{tag}`; they have no
expiry.

A custom `WritablePrerenderStore` implements `markStale(routerId, tags)` and
marks only entries whose `key.routerId` equals `routerId`.

### Fixed: a render that started before `updateTag()` is no longer served as fresh after it ([#1068](https://github.com/rangojs/rango/issues/1068))

`CFCacheStore` and `VercelCacheStore` stamped a cached entry with the time it
was written. A render that began before an invalidation and finished after it
was therefore stored as newer than the invalidation, holding old content. The
stores now stamp `set`, `setItem` and `putResponse` entries with the start of
the render that produced them (a stale-while-revalidate refresh stamps its
own). `CFCacheStore` with KV markers then rejects such an entry on any later
read, and `MemorySegmentCacheStore` refuses the write. `VercelCacheStore` and
`CFCacheStore` L1 hits in purge mode or without KV compare no marker on a data
read: there the stamp protects only the request that invalidated (its mask now
also covers a late write from another instance), and a later request still
gets the entry unless the write gate skipped the write
([#1071](https://github.com/rangojs/rango/issues/1071)). Nothing to change in
your app; a custom store keeps working and may read the optional
`CacheItemOptions.startedAt` and `CachedEntryData.taggedAt` to do the same.

### Added: `router.prerender()` warms any route before traffic ([#1062](https://github.com/rangojs/rango/issues/1062))

After a deploy that changes server code, and after an `updateTag()`, every
cache key starts cold: the first visitor to each URL pays the render. On-demand
prerender (in this release too) covers `Prerender(..., { onDemand })` routes.
Every other route's caches filled only from a visitor's request: a `ppr`
shell, `cache()` records, `"use cache"` results, a loader's own `cache()`,
the document cache.

`router.prerender()` now handles those routes too. For a route that is not
on-demand it sends the URL through the router's own handler as an anonymous
visitor would, in a mode where every cache read misses and every write
replaces the entry under the visitor's key. The old entries keep serving until
the new ones are written.

```ts
const prerender = router.prerender({
  env,
  ctx,
  origin: "https://shop.example",
});

await prerender("/products/1"); // any route: its next document request is a shell HIT
await prerender.many(urls, { concurrency: 4, onlyIfStale: true });
```

What to know before you call it:

- **The cache store must be shared.** A warm fills the cache where the call
  runs, so the router asks the store where its entries can be read
  (`SegmentCacheStore.scope`). `CFCacheStore` with `kv` is `"global"` and
  `VercelCacheStore` is `"regional"` (a warm fills the region it runs in, which
  is all traffic on a single-region project): both are warmed. `CFCacheStore`
  without `kv` and `MemorySegmentCacheStore` are `"local"`: the call returns
  `skipped-store-not-shared` and renders nothing. The memory store is allowed
  under the dev server, so you can try it locally. A custom store declares
  `scope: "global"` or `"regional"` to be warmed; without the field it is
  refused.
- **Cache keys carry the host.** A full-URL target uses its own origin. A path
  or `{ route, params }` target uses `origin` from the binding, or the origin
  of the request the call is made from (a server action, a route handler,
  `onRevalidate`). A cron or queue handler has no request: pass `origin`, or
  the result is `skipped-no-origin`.
- **The request is anonymous:** a `GET` with `accept: text/html` and no
  cookies. Middleware sees it; an auth redirect makes the result
  `render-failed`. A route that reads `cookies()` or `headers()` inside
  `cache()`, `"use cache"` or a `ppr` shell is `skipped-personalized`, as it
  is refused for a visitor.
- **The result says what happened.** Each one has `path: "on-demand" | "warm"`
  and, for a warm, `caches`: the writes that landed by store family, the
  shell's outcome and why a capture refused, and the document cache's
  outcome. New statuses: `warmed`, `skipped-store-not-shared`,
  `skipped-no-origin`, `shell-not-stored`, `skipped-uncached`.
- **An on-demand route gets both.** After the requestless render is stored,
  one warm request rebuilds the route's loaders' own `cache()` and the
  document cache on the new entry, when the app store is shared and an origin
  resolves.
- **To refresh changed content, invalidate and then warm:**
  `await updateTag(tag)` and then `await prerender(url)`. A warm does not
  reach a copy another edge location already holds; the invalidation makes
  those copies unservable.
- **What a warm does not write:** the records a client navigation reads
  (they fill on the first navigation), and anything behind an app entry that
  builds its own `createRSCHandler({ cache, version })` (a warm runs
  `router.fetch`).

`skipped-not-on-demand` is not a status of a refresh: a route that is not
on-demand is warmed. Only `prerender.remove()` returns it (below). See the
`prerender` skill, "Warm any route before traffic".

### Added: remove a page from on-demand prerender ([#1060](https://github.com/rangojs/rango/issues/1060))

Part of on-demand prerender, which is in this release too. When the item
behind a refreshed page is deleted, the page has to stop serving, and for a
param the build baked, the build-time page must not come back in its place.
There are two ways to remove a page:

```ts
const prerender = router.prerender({ env, ctx });

// From a "product deleted" webhook. Nothing is rendered, so it does not wait
// for the data source to catch up.
await prerender.remove("/products/42");
await prerender.remove.many(paths, { concurrency: 4 });

// Or let the route say so: a refresh whose render hits notFound() removes
// the page.
await prerender("/products/42"); // { ok: true, status: "removed", ... }
```

Both store a "removed" marker in the prerender store in place of the page.
From the next request on the route answers 404 for that param, in dev and in
production; a `Passthrough` route runs its live handler. A page the build
baked is covered too: its build-time entry is not served.

What to know before you call it:

- **A `notFound()` anywhere in the render removes the page**: the route
  handler, a layout handler, a parallel slot handler, any server component,
  sync or async. The result is `{ ok: true, path: "on-demand", status:
"removed" }`, so count `removed` in what a sweep reports. It removes the
  page only when nothing else went wrong: when the data source may be
  failing, throw anything else, which is `render-failed` and keeps the page.
  A render that hits a `notFound()` and another error is `render-failed`,
  whichever came first.
- **A `notFound()` removal is rechecked; `remove()` is permanent.** The
  marker of a refresh has the route's `ttl` and `tags`, like the page it
  replaces. Once it is stale (the `ttl` passed, or `markStale()` marked one of
  its tags) it still answers 404, a request schedules `onRevalidate`, and
  `{ onlyIfStale: true }` renders the page again: an item the data source
  lost for a moment comes back on the next recheck. A `remove()` marker has
  no `ttl` and no tags: nothing reaches it until a `prerender(url)` without
  `onlyIfStale` renders the page.
- **`ctx.passthrough()` in a refresh hands the page to the live handler.** A
  `Passthrough` route whose build handler declines a param gets
  `skipped-passthrough`, and the marker is stored so that the live handler
  answers, not a page stored or baked earlier.
- **`remove()` is for on-demand routes.** On any other route it returns
  `skipped-not-on-demand` and renders or warms nothing. `throwOnError` works
  as on a refresh, and the error names the call
  (`prerender.remove("/products/42") failed: ...`); `remove.many()` also
  takes `concurrency` (default 1).
- **Last write wins.** `remove()` and a refresh of the same page are two
  writes to one key. Pass `{ onlyIfStale: true }` where a refresh runs later
  than it was scheduled, in `onRevalidate` and in a queue consumer: a job
  queued before a removal then finds the marker and renders nothing, where a
  plain refresh would bring the page back. A marker that lands while a
  refresh is still rendering is not overwritten by that render's page, which
  narrows the race and cannot close it on an eventually consistent store.
- **Remove first, then invalidate, when a cache sits above the router.** No
  warm request follows a removal, and the marker does not reach a document
  cache (`createDocumentCacheMiddleware`): it keeps serving the document it
  stored until `s-maxage` and `stale-while-revalidate` run out. Call
  `await prerender.remove(url)`, then `await updateTag(tag)` for a tag the
  document carries. In the other order a visitor between the two calls is
  served the page the store still holds, and the document cache stores it
  again. `updateTag()` needs a request context: from a queue or cron handler
  the stored document serves until it expires. A `Passthrough` route's live
  handler serves through its own `cache()`, as it does for a page that was
  never refreshed.
- **A custom prerender store needs no change** when it persists the value it
  is given. The marker is `{ v: 1, removed: true, meta }` with no `entry`, and
  `meta` has the fields a page's has, with the same meaning.
  `PrerenderStoredEntry` is a union of the two, so code that reads
  `stored.entry` has to check for it. A store that cannot be read is a miss,
  for a marker as for a page: while it is failing, the build-time entry of a
  removed page can serve.
- **Intercepted navigations do not see the marker**: they do not read the
  prerender store, so the build's intercept variant of a removed page still
  serves.

The `notFound()` half is the Next.js Pages Router's rule: "With
`notFound: true`, the page will return a `404` even if there was a
successfully generated page before. This is meant to support use cases like
user-generated content getting removed by its author. Note, `notFound`
follows the same `revalidate` behavior described here."
([getStaticProps](https://nextjs.org/docs/pages/api-reference/functions/get-static-props))
See the `prerender` skill, "Remove a page".

### Added: `MemorySegmentCacheStore({ scope })` lets a single-process server be warmed

`router.prerender()` warms a route only into a store that is shared beyond the
process that runs the call. `MemorySegmentCacheStore` is per process, and the
router cannot tell one long-running server from several replicas or serverless
instances, so it stays `"local"` and a production warm of it returns
`skipped-store-not-shared`: counting it as shared by default would report
`warmed` while most visitors reached a cold instance.

If you do run exactly one process (a single Node server), say so:

```ts
import { MemorySegmentCacheStore } from "@rangojs/router/cache";

const store = new MemorySegmentCacheStore({
  scope: "global",
  defaults: { ttl: 60, swr: 300 },
});
```

A warm of that store is `warmed` in production. Without the option nothing
changes: the store is `"local"`, refused in production and counted as shared
under the dev server. You no longer need a subclass declaring
`readonly scope = "global"`. Two instances with the same `name` share their
maps but each keeps its own `scope`, like `defaults` and `keyGenerator`: keep
them identical.

### Fixed: two routers on one cache store no longer share entries for the same host and path ([#1065](https://github.com/rangojs/rango/issues/1065))

A cached entry was keyed by the request's host and path. That names one page
while each host goes to one router, the usual `createHostRouter()` setup. It
does not when two routers answer under the same host and path:

- `createHostRouter({ hostOverride })` picks the app from a cookie and
  forwards the request unchanged, so on a preview origin every app serves the
  same URL host;
- a `fallback()` mapped to an app serves that app under whatever host the
  request named;
- `router.prerender()` warms the origin it resolved, which can be another
  app's host.

With one cache store behind both routers, what went wrong depended on their
versions:

| Versions of the two routers                                                              | `ppr` shell                                                                                                                  | Every other entry listed below                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| The same (development, or one `version` on both routers or on the store)                 | The second app's request was a HIT with the first app's page                                                                 | The second app was served the first app's entry |
| Their own (a production build), on `MemorySegmentCacheStore` or a store without versions | Each app's capture replaced the other's shell: a request after the other app's was a MISS again, so neither app kept a shell | The second app was served the first app's entry |
| Their own, on `CFCacheStore` or `VercelCacheStore`                                       | Stored apart already: the version is in the storage key                                                                      | Stored apart already                            |

The other entries are the ones that hold one router's output: a route's
`cache()` record, a document-cache response, a response route's entry, a
loader's own `cache()` entry, and a `"use cache"` entry of a function called
with a handler or loader `ctx`. A `ctx` belongs to one router (its context
variables, its `env`, its `reverse()` map), so a loader both apps mount, or a
`"use cache"` function both call with `ctx`, returned the first app's value
to the second.

A build-time shell had the same gap: `vite build` staged it under the
pathname, so another router with a `ppr` route on that pathname and the same
`version` served it.

Those keys now start with the id of the router that serves the request
(`{routerId}@{host}{path}...`), and a build-time shell is staged under the id
of the router it was captured for. Each app reads and writes its own shells,
records, responses, loader entries and `ctx`-keyed `"use cache"` entries.

```ts
// preview.dev serves every app; the cookie names the one to show
const host = createHostRouter({
  hostOverride: { cookieName: "app", allowedHosts: ["preview.dev"] },
});
host.host("shop.internal").lazy(() => import("./apps/shop/handler.js"));
host.host("admin.internal").lazy(() => import("./apps/admin/handler.js"));
// GET https://preview.dev/pricing with app=shop.internal, then with
// app=admin.internal: each app gets its own MISS, then its own HIT.
```

Nothing to configure, and no namespace or version to manage: the id is the
router's own. Each router of a multi-router app needs a stable one, which
routes and cache versions need already: write the `createRouter({ ... })`
options as an object literal, so the Vite plugin gives the router an id, or
pass `id`. The build's existing `N routers use auto-generated IDs` warning
names the case that has neither.

After upgrading, the stored keys are new. What that costs depends on where
the app's cache versions come from:

- **Build-computed versions (the default):** nothing extra. Upgrading the
  router already changes every cache version, so this release refills every
  stored entry with or without the new keys.
- **A pinned `version`** (`createRouter({ version })`, or `version` on the
  store), and **a custom store that ignores versions:** the entries above are
  lost once. `ppr` shells are captured again, and records, responses, loader
  entries and `"use cache"` entries called with `ctx` refill on their next
  request.

A single-router app otherwise behaves as before: the same hits and misses and
the same number of store reads. Unchanged, because they name no router: a
`"use cache"` entry of a function called with plain arguments or a bare
`Request`, tag markers, and keys you build yourself (`cache({ key })` on a
route or a loader, the document cache's `keyGenerator`).

### Breaking: the testing helper `shellCacheKey()` takes the router first ([#1065](https://github.com/rangojs/rango/issues/1065))

A shell's store key now names the router that serves it, so the helper that
builds that key needs the router:

```ts
// Before
const key = shellCacheKey("/products/1");

// After
const key = shellCacheKey(router, "/products/1");
```

`router` is the router under test, or `{ id }` where the router cannot be
imported (a Playwright test). `searchParams` and `partition` follow as
before. TypeScript reports every call that still passes the URL first.
`serveShellRequest()` is unchanged: its `result.key` is the key the serve
path resolved.

### Fixed: a superseded link click no longer follows its server redirect ([#1047](https://github.com/rangojs/rango/issues/1047))

When you clicked a link, then clicked another before the first response
arrived, and the first response turned out to be a redirect (route middleware
sending a signed-out visitor to the login page), the router still followed that
redirect and replaced the page you had moved on to. A superseded navigation now
ends without following its redirect, the same as a superseded Back/Forward.

### Fixed: server redirects that loop no longer re-navigate forever ([#1047](https://github.com/rangojs/rango/issues/1047))

Two pages whose middleware redirect to each other made the client navigate
back and forth without end. The client now stops after following 20 redirects
in one navigation, as browsers do for a document, logs
`[rango] Server redirect loop: stopped after following 20 redirects, at <url>`,
and renders the error boundary. A new link click or `router.push()` starts
counting again from zero. There is no option to change the limit.

### Fixed: a slow deferred push from an `ssr: false` loader no longer stops the shell capture ([#1035](https://github.com/rangojs/rango/issues/1035))

Since 0.21.0 a shell keeps only the pushes of a loader that are settled
values; a promise a loader pushes is live, has no place in the shell and
arrives after hydration. The capture still waited for that promise before it
stored the shell. If it settled after `ppr.captureTimeout`, or never (it
waits on a live loader the capture masks), the capture was refused and the
route had no shell for a value the shell does not hold.

The capture now waits only for what the shell keeps: handler pushes (baked,
still bounded by `ppr.captureTimeout`) and the settled pushes of loaders. The
loader still runs on a HIT and delivers its promise after hydration, as before.

```tsx
path("/product/:id", ProductPage, { name: "product", ppr: true }, () => [
  loader(ProductLoader, { ssr: false }), // pushes a promise that takes 20s
]);
// before: no shell is ever stored (capture refused, once-per-key warning)
// now:    the shell is stored; the HIT's HTML has the settled push, the
//         promise's value shows after hydration
```

A promise a handler pushes is baked into the shell, so the capture waits for
it and is still refused when it misses the deadline.

### Fixed: a `Prerender` + `ppr` shell HIT hydrates with the handle values its `ssr: false` loaders pushed ([#1057](https://github.com/rangojs/rango/issues/1057))

On a route that combines `Prerender` with `ppr`, a settled handle value an
`ssr: false` loader pushed was in the shell's HTML but not in the data the
page hydrated with. Every shell HIT failed hydration (React error #418 in
production, "Hydration failed" in dev), and the element was removed and
never came back. The document MISS, and the same route without `Prerender`,
were clean. The loader's data was correct; only its handle values were lost.

```tsx
const Notes = createHandle<string>();

const Product = createLoader(async (ctx) => {
  ctx.use(Notes)("In stock"); // settled
  return { stock: await db.stock() };
});

path(
  "/product",
  Prerender(async () => <ProductPage />),
  { ppr: true },
  () => [loader(Product, { ssr: false })],
);
// <ProductPage> renders useHandle(Notes)
```

The shell entry now keeps those values itself (the prerender store supplies
the page's handler output and has none of them), and a HIT hydrates with
them, as a `ppr` route without `Prerender` does. Both shells are covered: the
one `vite build` bakes, and one captured at runtime (a URL with a query
string, or the recapture after `ppr.ttl`). A promise pushed from the loader
stays live, as on any shell: not in the HTML, delivered after hydration.

Nothing to change in an app. A shell stored by 0.21.0 or earlier still
serves as it did, hydration error included, until it is replaced: the
upgrade changes the router's document version, so the deploy that ships it
retires those shells unless the app pins its own `version`. In development
on the Cloudflare preset, the build-time shell is now captured from the
prerendered output, as in production, instead of from a render of the
`Prerender` handler.

## 0.21.0 (2026-10-04)

### Fixed: Back/Forward to an entry the server now redirects follows the redirect ([#1047](https://github.com/rangojs/rango/issues/1047))

On Back or Forward to an entry that has to be fetched (it left the client's
20-entry history cache, or the cache was cleared), a server that now answered
with a redirect, for example route middleware that sends a signed-out visitor
to the login page, was not followed. The router logged `Unprocessable popstate
response: ServerRedirect`, showed the root error boundary, and left the
address bar on the protected URL. A link click or `router.push()` to the same
page followed the redirect.

The redirect is now followed, with the same same-origin check and location
state a push uses. The redirect replaces the entry that was traversed to: that
history entry becomes the redirect target, and Back from the target goes to
the entry before it. A push would keep the redirecting entry in history, and
Back would hit the redirect again.

```tsx
// History: [/home, /account, /a, /b, ...]; /account has left the history
// cache and its middleware now redirects to /login.
// Back to /account:
//   before: root error boundary, address bar on /account
//   now:    /login is shown, history is [/home, /login, /a, /b, ...]
//           Back from /login goes to /home
```

### Changed: `@vitejs/plugin-rsc` is a dependency of `@rangojs/router`, no longer also a peer ([#1050](https://github.com/rangojs/rango/issues/1050))

`@rangojs/router` declared `@vitejs/plugin-rsc` (`^0.5.35`) twice: as a
dependency and as a required peer. It is now only a dependency, with the same
range. The README already told you not to install it, and `rango()` already
resolved it through the router; the peer entry said the opposite.

You notice this at install time. pnpm and npm no longer ask for it as a peer
or report it as a missing one. npm still places it in the root `node_modules`,
because its flat layout hoists the router's dependencies; pnpm keeps it under
the router. An app that lists `@vitejs/plugin-rsc` in its own `package.json`
keeps working (one copy is installed) and can drop the entry. Nothing changes
at run time.

### Fixed: on Back/Forward, `usePathname()` and `useSearchParams()` change with the page, not before it ([#1031](https://github.com/rangojs/rango/issues/1031))

On Back or Forward to an entry that has to be fetched (it left the client's
history cache, or the cache was cleared), the page being left stays on screen
until the entry's page arrives. `usePathname()` and `useSearchParams()` did
not wait: they changed at the `popstate` event, so for the whole wait the page
on screen read the destination's URL. An active-link highlight, a breadcrumb
or a filter panel derived from the URL showed the destination next to the old
page's content. A link click and `router.push()` / `router.replace()` never
did this, and `useParams` and `useLocationState` already waited.

The router now moves its location where the entry commits: with the response
for an entry that is fetched, the place a push moves it, and in the restore
for an entry served from the history cache.

```tsx
const pathname = usePathname();
const [searchParams] = useSearchParams();
const nav = useNavigation();

// Back to /products?page=2 from /products?page=23; the entry is fetched.
// While the request is out, page 23 is on screen:
//   before: searchParams.get("page") === "2"
//   now:    searchParams.get("page") === "23"
//           nav.state === "loading", nav.pendingUrl ends in "/products?page=2"
```

| Back/Forward                                                           | The URL hooks changed            | Now                                                              |
| ---------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| entry in the history cache                                             | at `popstate`, the page after it | with the restored page, in one commit (no visible difference)    |
| entry fetched, while the request is out                                | at `popstate`                    | when the entry's page commits                                    |
| entry fetched, response arrived, React still holds the page being left | at `popstate`                    | when the entry's page commits, for components already mounted    |
| the fetch fails                                                        | at `popstate`                    | with the error boundary; they report the entry the browser is on |

`useSegments().path` and `useNavigation().location` read the same location
and move with it.

What an existing app can notice:

- **During a Back/Forward that fetches, the hooks disagree with the address
  bar.** The browser changes `window.location` and `history.state` before it
  tells the router; the hooks now keep the URL of the page on screen until
  the entry's page commits. Code that reads `window.location` next to the
  hooks sees two URLs for that wait. For anything rendered, read the hooks.
- **UI derived from the URL flips with the page**, not at the button press:
  active links, breadcrumbs, tabs, a filter panel. For feedback during the
  wait read `useNavigation()`: `state === "loading"` and `pendingUrl` while
  the request is out, `isStreaming` for the whole wait.
- **`useNavigation().location` no longer equals `pendingUrl` while a
  Back/Forward request is out.** `location` is the page on screen and
  `pendingUrl` the entry being fetched, as during a push.
- **`setSearchParams((prev) => ...)` during a pending Back/Forward builds on
  the search of the page on screen**; before, on the destination's.
- **Link prefetching re-arms when the location commits**, not at the
  `popstate` event.

Not changed: a push or replace, `router.push(url, { revalidate: false })`,
server actions, `useParams`, `useLocationState`, and scroll restoration and
`transition({ when })`, which read the browser's entry and the router's
store, not this location.

Still open:

- A component that first mounts in the page being left after the response
  arrived, while React still holds the destination, reads the destination's
  URL and params from `usePathname()`, `useSearchParams()`, `useParams()` and
  `useSegments()`, and `useNavigation().location` is ahead of the screen for
  that part of the wait. A push has the same gap
  ([#1046](https://github.com/rangojs/rango/issues/1046)).

### Fixed: `pnpm dev` no longer warns about `@vitejs/plugin-rsc/vendor/react-server-dom/static.edge` ([#1050](https://github.com/rangojs/rango/issues/1050))

An app that installs only `@rangojs/router`, `react`, `react-dom` and `vite`
(as the README says) printed this on every `pnpm dev` under pnpm's strict
`node_modules`:

```
Failed to resolve dependency: @vitejs/plugin-rsc/vendor/react-server-dom/static.edge, present in rsc 'optimizeDeps.include'
```

The app still served; the module was left out of the dependency pre-bundle.
`rango()` now resolves that entry through `@rangojs/router`, as it already
did for the other `@vitejs/plugin-rsc/vendor/*` entries, so the warning is
gone without adding `@vitejs/plugin-rsc` to your `package.json`. An app that
does list `@vitejs/plugin-rsc` needs no change.

### Fixed: `buildEnv: "auto"` reads the wrangler config of the Vite root

With `rango({ preset: "cloudflare", buildEnv: "auto" })`, building from a
directory other than the app's (`vite build apps/web` from a monorepo root)
looked for the wrangler config in the working directory, found none, and gave
`Prerender` and `Static` handlers an `env` without the app's bindings
(`Cannot read properties of undefined (reading 'put')`). The config is now
searched upward from the Vite root, as `wrangler.json`, `wrangler.jsonc`, then
`wrangler.toml`, and build-time state persists in `.wrangler/state/v3` under
the Vite root, where the Cloudflare Vite plugin reads it in dev and preview.
With no config found, wrangler's own lookup applies as before.

### Breaking: a deploy keeps the cache of every app whose code it did not change

Every production build used to get a new version, the build time, and every
persistent cache key and stored PPR shell was tied to it. So every deploy
started with a cold cache, a rebuild of unchanged source cleared it, and under
a host router a deploy of one app cleared the cache of all the others.

`vite build` now computes two versions for each `createRouter()` from that
router's built code, and the stores key with them:

- the **data version**, a hash of the router's server code, keys cached RSC
  data: `cache()` segment entries, `"use cache"` values, loader data;
- the **document version**, the data version plus the SSR output, the client
  asset file names and the router's `Prerender` payloads, keys stored HTML
  (PPR shells, document-cache responses) and is what an open tab's `_rsc_v` is
  compared with.

The same code builds to the same versions, on any machine and in any checkout
directory, so the new deployment finds the entries the previous one wrote.

| Deploy                                   | Cached data         | Stored HTML           | Open tabs               |
| ---------------------------------------- | ------------------- | --------------------- | ----------------------- |
| Before: any deploy, any rebuild          | cleared             | cleared               | reload                  |
| Rebuild or redeploy, no code change      | kept                | kept                  | untouched               |
| Server code of app A changes             | cleared for A only  | cleared for A only    | A's tabs reload         |
| Client code of any app changes           | kept for every app  | cleared for every app | every app's tabs reload |
| Server code shared by A and B changes    | cleared for A and B | cleared for A and B   | A's and B's tabs reload |
| A dependency changes (React, rango, any) | cleared             | cleared               | reload                  |
| A stylesheet server code of app A links  | cleared for A only  | cleared for every app | every app's tabs reload |
| New `Prerender` content, same code       | kept                | cleared for that app  | that app's tabs reload  |
| New `Static()` content, same code        | cleared for the app | cleared for that app  | that app's tabs reload  |

"A dependency" is one your server code imports: bundled into the build, or on
the node preset left external and resolved from `node_modules` (the version
covers what is installed there for it, and for its own dependencies).

Every build prints what it computed, and writes what each version was
computed from to `node_modules/.rangojs-router-build/cache-versions.json`.
Diff that file between two builds to see which chunk, payload or key moved a
version.

```
[rango] Cache versions for 2 router(s), data / document (13.5ms):
[rango]   089295a905c2ac9c / 04f098c068051ed1  src/apps/shop/router.tsx
[rango]   83115bcfbb9b35c1 / fc93d46fcd5ab63e  src/apps/blog/router.tsx
```

What changes for you:

- **Entries now outlive a deploy.** If you relied on a deploy to clear the
  cache (new CMS content rendered by a `"use cache"` function or a `cache()`
  route, a changed upstream response), it no longer does. Invalidate the tags
  (`updateTag()` / `revalidateTag()`), or change `version`.
- **To clear a router's cache on demand**, change `createRouter({ version })`:
  that exact value is used for both versions.
- **To keep the old behavior**, set `version` to a per-deploy value:
  `createRouter({ version: process.env.BUILD_ID })`. On Vercel a
  deployment-scoped handle does the same
  (`getCache({ namespace: process.env.VERCEL_DEPLOYMENT_ID })`).
- **`VercelCacheStore` is versioned by default.** It had no default version:
  its keys were unversioned unless you passed `version`, and the documented
  wiring put the deployment id in the `getCache()` namespace, which cleared the
  cache on every deploy. It now keys with the router's versions like
  `CFCacheStore`. Drop the deployment id from the namespace to keep the cache
  across deploys. Entries written without a version are not read any more.
- **Two environments built from the same code have the same versions.** If a
  preview and production share a store (the same KV namespace), they now share
  entries. Give each environment its own KV namespace or cache namespace, or
  its own `version`.
- **A router whose build output differs on every build gets a new version on
  every build.** That is a `Prerender` or `Static()` handler rendering a
  timestamp or a random id, and an inline server action with bound arguments
  inside one (its arguments are encrypted with a random IV). `cache-versions.json`
  lists them as `prerender ...` and `static ...`. A random encryption key does
  the same for every router that encrypts with it: see `encryptionKey` below.
- **Apps are independent when the host mounts them lazily.** A router's
  version covers everything the modules that statically import it can run. An
  app mounted with `.lazy(() => import("./apps/shop/handler.js"))` is on its
  own; routers that one module imports statically share that module's code,
  and a change to either moves both versions.
- **The host entry is not part of a lazily mounted app's version.** A change
  to the file that creates the host router, or to host middleware, does not
  clear the mounted apps.
- **A stylesheet your server code links is part of the cached data.** That is
  `import "./x.css"` in a server component and `import href from "./x.css?url"`
  in a server module (a document that renders `<link href={href}>`). Its
  hashed URL is in what the server renders, so a change to the compiled CSS
  clears that app's cached data. With a framework that compiles one stylesheet
  from every class in the app, that is any class change, so "a client change
  keeps cached data" holds for changes that leave the compiled CSS alone. A
  stylesheet imported by a client component is not in any cached payload.
- **A `clientUrls()` module is client code that also tells the server what to
  run.** Changing which loaders a route declares, its `loading` or its
  transition changes that app's data version, like a server change. Changing
  the components it renders does not.
- **On the node preset, the version covers what is installed.** For each
  dependency the server build leaves external, the installed `name@version`
  of the package and of its dependencies is part of the version. A file the
  server build imports by path and leaves external is covered by its bytes.
- **What the build cannot read gives a new version on every build, or fails
  the build.** A package it cannot find in `node_modules`, a path that does
  not resolve and an import by URL give the routers importing them a new
  version on every build, and the build names them. A build output file it
  cannot read, a missing plugin-rsc assets manifest and a missing encryption
  key file (when your code encrypts action arguments) fail the build. A
  version never stays the same because an input could not be read.
- **Where and how you build does not change the versions.** The same source
  gives the same versions in any checkout directory, whether you run
  `vite build` in the app or `vite build apps/web` from the repository root,
  and whatever peers pnpm installed a bundled dependency against. One
  exception: with `build.minify: false` on the client build, the client asset
  names depend on the working directory, and the document version with them.
- **Every router's generated id changed.** The id is now a hash of the
  router's file path and its position among the `createRouter()` calls in that
  file. It was a hash of the path and the call's line, taken from the
  transformed code, where a build drops comments and a dev server keeps them:
  build-time route discovery and the bundle disagreed on the id of any router
  with a comment above the call, so the build registered that router's lazy
  route data under an id the running router did not have and the router
  rebuilt its route trie at run time. And a blank line or a comment added
  above the call changed the id, the state cookie name and the router's cache
  versions. The rango state cookie is named after the router id, so clients
  start one new state cookie; a router with an explicit `id` is unaffected.
- **A task scheduled with `ctx.waitUntil()` runs inside the request context.**
  It re-enters the context it was scheduled under, so a task that writes to a
  cache store, or calls `getRequestContext()`, no longer relies on the
  platform carrying the request's async context into deferred work. Node and
  miniflare do; deployed workerd was seen not to (the `"use cache"`
  revalidation fix). A cache store builds its key in such a task from the
  serving router's versions and the request host.
- **A cache key built outside a request is logged, once per process.** A store
  operation with no request context keys with the whole-build version; when
  routers have versions of their own, that entry is not read by them. The
  warning names it.
- **`createRouter({ version })` is honored on the node and vercel presets.**
  The generated entry passed the build version over it.
- **`import { VERSION } from "@rangojs/router:version"`** is the whole-build
  document version in production, not a timestamp. The module also exports
  `ROUTER_VERSIONS`, the per-router table.
- **The node and vercel server builds split differently.** The RSC entry is
  built with `preserveEntrySignatures: "strict"`, as the Cloudflare preset's
  already was, so code shared with lazily loaded chunks is emitted as chunks
  instead of being exported from `dist/rsc/index.js`.

Nothing changes in dev: one version, bumped on every server module edit. And
nothing changes for an app that sets `version` itself.

A custom persistent store can key the same way with `getCacheVersions()` from
`@rangojs/router/cache`. In tests, `setBuildVersions()` from
`@rangojs/router/testing` installs the versions a build would ship; calling it
again is a deploy:

```ts
setBuildVersions({ data: "d1", document: "h1" });
await serveShellRequest(router, "/product/1", { cacheStore }); // MISS, captured
setBuildVersions({ data: "d1", document: "h2" }); // a client-only deploy
const { shellStatus } = await serveShellRequest(router, "/product/1", {
  cacheStore,
});
expect(shellStatus).toBe("MISS"); // stored HTML is keyed by the document version
```

### Added: `rango({ encryptionKey })`, the key inline server actions encrypt their arguments with

An inline server action that closes over a value sends that value to the
browser encrypted. The key was generated per build unless the
`RANGO_ENCRYPTION_KEY` environment variable was set. It is now a plugin
option, to be passed from the environment and never written as a literal:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [rango({ encryptionKey: process.env.RANGO_ENCRYPTION_KEY })],
});
```

Generate one with `openssl rand -base64 32`. The value is checked when
`rango()` runs: a string that is not base64, or that does not decode to an AES
key size, fails the config load instead of the first action in production.
`undefined` (the variable is unset) falls back to `RANGO_ENCRYPTION_KEY`, then
to a key generated for the build, as before.

Why you want one now: a payload cached under one key carries arguments another
key cannot decrypt, so the key is part of the cache version of every router
whose code encrypts with it. Without a stable key those routers get a new
version, and a cleared cache, on every build. The build tells you when that
applies:

```
[rango] No stable encryption key: 1 router(s) encrypt server-action arguments with a key generated for this build, so their cache version changes on every build and each deploy clears their cache. ...
```

A router with no inline action that closes over a value encrypts nothing and
keeps its cache either way; file-level `"use server"` actions do not count.
Rotating the key clears the cache of the routers that encrypt with it.

### Changed: a tag invalidation applies to the entries of every version

`CFCacheStore` stored a tag's invalidation marker under the build version, in
KV (`v/{version}/__tag__/{tag}`), in the edge cache and in its per-isolate
memo, and `VercelCacheStore` did the same when given a `version`. That was
harmless while a version was a build time and never came back. A version is
now a hash of the code, and a hash can be live twice: deploy A, deploy B, roll
back to A. An `updateTag()` made while B was live wrote nothing A's entries
looked at, so after the rollback they were served until their TTL.

Markers are stored without a version now (`__tag__/{tag}` in KV,
`rg:tm:{tag}` on Vercel), so an invalidation reaches the entries of every
version. The freshness check is unchanged: it compares the marker's time with
the time the entry's tags were attached. Markers written before this release
are not read any more; they expire by `tagInvalidationTtl`.

One case needs an action. If you pin the store's version
(`new CFCacheStore({ version })` or `new VercelCacheStore({ version })`), your
entries keep their keys across this upgrade while the markers that
invalidated them are no longer read, so an entry tagged before your last
`updateTag()` is served again until its TTL. Change the pinned value once when
you upgrade. A store without a pinned version is not affected: its entries
were written under a build time and are not read by the new build.

Otherwise nothing changes in app code. `createCloudflareZonePurge` and
Vercel's `expireTag` were already version-free.

### Breaking: location state written by another app version reads as no state ([#1020](https://github.com/rangojs/rango/pull/1020))

A history entry outlives a deploy: a tab left open across a release keeps its
`history.state` through reloads and back/forward. A location state key is the
file path plus the export name, so it is the same in every deploy, and the read
was an unchecked cast. After a release that changed a state's shape, the new
code got the old value typed as the new one (#994).

Location state is now versioned by the app version, the one the router already
uses to reload a client that is behind the server. Every history entry records
the version its location state was written under, and a read returns only
state recorded under the version the page was loaded with. This covers all
location state: `createLocationState` definitions (`useLocationState(Def)`,
`Def.read()`, `flash` included), plain state (`<Link state={{ ... }}>` read
with `useLocationState()`), and state the server sets
(`ctx.setLocationState()`, `redirect(url, { state })`).

There is nothing to configure and no version to manage: no option sets it and
no API returns it.

| An entry's location state, read by                               | Before                          | After                                  |
| ---------------------------------------------------------------- | ------------------------------- | -------------------------------------- |
| the build that wrote it: navigation, back/forward, refresh       | the value                       | the value (unchanged)                  |
| a later build, after a refresh or a restored tab                 | the old value, typed as the new | `undefined`                            |
| a later build, on back/forward to an entry the older build wrote | the old value, typed as the new | `undefined`                            |
| any build, when a release older than this one wrote the entry    | the value                       | `undefined`                            |
| a release older than this one, after a rollback                  | the value                       | the value: it does not read the record |

- **This happens on every deploy that changes the app.** The default app
  version is the router's document version (the cache-version entry above): a
  hash of the app's server code and the client assets. A deploy that changes
  either is another version, and state a user had in an open tab (a filter
  carried on a link, a flash message not shown yet) is gone after it, as if
  the entry never had any. A rebuild or redeploy of unchanged code keeps it.
  Readers already handle `undefined`. State that has to outlive a deploy that
  changes the app belongs in the URL, a cookie or storage.
- An app that pins its own app version instead of the generated one keeps
  location state for as long as that value stays the same.
- On the first release with this change, every entry written before the
  upgrade counts as another version: open tabs lose their location state once.
- Keys and values are stored as before. The record is one extra field on the
  entry (`__rsc_lsv`). A write into an entry another version wrote drops that
  entry's older location state first; the router's own bookkeeping on the
  entry (scroll key, intercept context) is kept.
- In development a server-module edit changes the version (HMR). The running
  page keeps its location state; a document load after the edit drops it, as
  after a deploy.
- Unit tests need no version: `renderRoute` seeds read back as before, and the
  `.locationState` of `runMiddleware`, `runLoaderResult`,
  `runInRequestContext` and `renderHandler` is still
  `{ [Def.__rsc_ls_key]: value }`.

### Added: `createLocationState({ clearOnReload: true })` drops the state when the entry's document is loaded ([#1020](https://github.com/rangojs/rango/pull/1020))

The server renders a document without `history.state`, so `useLocationState`
hydrates as `undefined` and applies the stored value right after. For state
that decides how much content is on the page, that is a layout shift on every
refresh. A "load more" list is the case: `?page=6` loads 50 products through a
loader and the 250 already on screen ride along as location state on the
link. After a client navigation that is what you want. After a refresh the
server renders 50 products and the client then inserts 250 above them.

```ts
export const CarriedProducts = createLocationState<Product[]>({
  clearOnReload: true,
});
```

```tsx
const { data } = useLoader(ProductsLoader); // the page named by ?page
const carried = useLocationState(CarriedProducts) ?? [];
const products = [...carried, ...data.products];

<Link
  to={`/products?page=${data.page + 1}`}
  state={[CarriedProducts(products)]}
  scroll={false}
>
  Load more
</Link>;
```

| What happens to the entry                                                 | Without the option      | With `clearOnReload: true`                            |
| ------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------- |
| The reader mounts during a client navigation                              | state applied           | unchanged                                             |
| back/forward inside the running app, a server action's state              | state applied           | unchanged                                             |
| Refresh, or a back/forward that loads the document from the server        | applied after hydration | not applied; the slot is removed from `history.state` |
| Later on that page: a reader mounts, or a navigation returns to the entry | state applied           | still `undefined` until the next write                |
| The page is restored from the back/forward cache                          | state and DOM kept      | unchanged                                             |

- The slot is stored under `<key>~r` (`<key>` is the key the Vite plugin
  injects), value as-is. When the client starts, before it hydrates, the
  router removes every `~r` key from the entry. It goes by the key alone, so
  it does not depend on a reader being mounted, on where the reader sits (a
  `<Suspense>` boundary that hydrates late included), or on the definition's
  module being loaded. Other slots on the entry are kept.
- Any document load of the entry counts, not only the Reload button:
  restoring a closed tab and duplicating a tab load the document too. Only
  the loaded entry is cleared; going back from it to an earlier entry is a
  client navigation and applies that entry's state.
- State the server sets is not affected. A document response carries no
  location state; `ctx.setLocationState()` and `redirect(url, { state })`
  reach `history.state` through navigations and actions in the running app,
  which start after the slot was removed.
- Adding the option to an existing definition moves it to the `~r` key: what
  was stored before, under the plain key, is no longer read and is not
  removed. Removing the option moves it back; what was stored under `~r` is
  removed at the next document load. A rollback behaves like removing it.
- It cannot be combined with `flash`: `createLocationState` throws in
  development, since flash state is removed at its first read and the option
  could only drop a message nobody has seen.

To test it, plain `renderRoute(routes, { locationState })` is the client
navigation and `renderRoute(routes, { hydrate: true, locationState })` is the
document load: hydrate mode removes the seeded slot with the same function the
client start-up calls. `Def.__rsc_ls_key` returns the key with its suffix:
`withLocationStateKey(CarriedProducts, "CarriedProducts")` still names the
definition, the key is then `__rsc_ls_CarriedProducts~r`, and
`{ [CarriedProducts.__rsc_ls_key]: value }` is the assertion that holds for
any definition. The helper rejects a name that contains `~`.

Definitions that do not set the option keep their key, and the client start-up
writes nothing to `history.state` when no key carries the suffix.

### Fixed: `useLocationState` changes together with the page it belongs to, not before it ([#1029](https://github.com/rangojs/rango/issues/1029))

A `useLocationState` reader received the destination entry's state as soon as
the router pushed the entry, before the destination's content was on screen.
For as long as the navigation was held (a loader still streaming, a
`transition()`), the page showed the new entry's state next to the old
entry's data. A "load more" list was the visible case: `?page=N` loads a page
through a loader and the items already on screen ride along as location state
on the link, so after the click every item of the current page was listed
twice until the next page landed, with React's duplicate-key warning in
development. Back/forward had the same shape: the reader took the restored
entry's state at the `popstate` event, before the restored page. A reader
that mounted during the wait read the destination's state too.

A reader now sees an entry's location state only together with that entry's
page. The router keeps the state of the entry on screen next to the page it
renders and changes both in one React commit, so the rule holds for a reader
that is mounted across the navigation and for one that mounts while it is
pending.

```tsx
const { data } = useLoader(ProductsLoader); // the page named by ?page
const carried = useLocationState(CarriedProducts) ?? [];
const products = [...carried, ...data.products]; // no item twice, at any point
```

State on the navigation means `<Link state>`, `router.push()` / `.replace()`
with `state`, and what the server adds to it (`ctx.setLocationState()`,
`redirect(url, { state })`).

| What changes the entry's state                                                                               | A reader got it                                                                    | Now                                                              |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| a navigation React commits in a transition: any same-route navigation, a `transition()` route, a held loader | when the entry was pushed: before the page, for as long as it was held             | in the commit that shows the destination                         |
| a navigation to another route that commits at once; an intercept (a modal over the page)                     | with the page                                                                      | unchanged                                                        |
| back/forward, entry in the client cache                                                                      | around the restore, in a commit of its own                                         | in the commit that restores the entry                            |
| back/forward, entry refetched                                                                                | at the `popstate` event, for the whole fetch                                       | in the commit that shows the refetched entry                     |
| a navigation the server answers with nothing to re-render                                                    | when the entry was pushed                                                          | with the new location: the page on screen is the entry's         |
| `router.push(url, { revalidate: false })` (no server fetch)                                                  | at once                                                                            | unchanged: at once, with the new location                        |
| a server action's `setLocationState` (no navigation)                                                         | when the response arrived                                                          | unchanged moment; added to what readers show (see below)         |
| `flash` state                                                                                                | shown, and cleared from history, at the moments above                              | shown with the destination, then cleared from history            |
| `Def.write()` / `Def.delete()`                                                                               | a mounted reader: at the next row above; a reader mounted afterwards: at its mount | when the entry is next restored: back/forward to it, or a reload |
| a `clientUrls()` destination presented before the server answers                                             | the entry being left, until the server answered                                    | the state the navigation carries, from its first render          |
| a navigation superseded or cancelled before it commits                                                       | nothing                                                                            | unchanged: nothing                                               |
| a reader that mounts while a navigation is pending                                                           | the destination's state, in the page being left                                    | the state of the page it mounts in                               |

`clientUrls()`: inside the optimistic branch (the destination and the group's
client layouts) a reader gets the `state` the navigation carries on its first
optimistic render, as `useParams` and `usePathname` describe the destination
there. Before, it read the entry being left until the server answered, so a
product page could not show the name its link carried while its loader
streamed. Chrome outside the group, and content the navigation keeps on
screen (a same-route navigation, a destination that suspends with no
boundary), keep the committed entry's state until the canonical commit. State
the server adds is not part of the optimistic entry and arrives with that
commit. In the branch the value is the object the navigation passed; from the
commit on it is the entry's copy, so an object-valued slot is a new, equal
object at that point.

What an existing app can notice:

- **A reader in content that stays on screen no longer previews the next
  entry.** If a layout read `useLocationState` to show something about a
  navigation still in flight (the name of the product being opened, say), it
  now shows it when the destination commits. For the pending window use
  `useNavigation()` or `useLinkStatus()`, or read the state in the
  destination: a component that mounts with the destination, its `loading()`
  skeleton and an intercepted modal's skeleton included, reads its entry's
  state on its first render, as before.
- **A reader that mounts after `Def.write()` / `Def.delete()` no longer sees
  the change.** Readers show the entry's state as it was committed, whenever
  they mount; the written value reaches them when the entry is restored
  (back/forward to it, a reload). Before, a reader mounted after the write
  read it. `Def.read()` returns it at once, as before: a component that
  writes a draft and re-mounts in the same visit should initialise from
  `Def.read()` in an effect, or keep the draft in state above the re-mount.
- **A `flash` value is shown until the next navigation commits, by every
  reader.** Three differences. It is cleared from `history.state` after the
  destination commits, not when the entry is pushed. A reader that stays
  mounted across a later navigation (a banner in a layout) no longer keeps
  the message: an entry that carries no flash shows none; before, it kept it
  until it unmounted or a back/forward. And a reader that mounts or re-mounts
  later in the same visit gets the message too, where before only readers
  that rendered before the first clear did: an effect keyed on the value (a
  toast) runs again on a re-mount. A server action's state does not end a
  flash on screen.
- **Every reader renders once when a navigation changes the entry's location
  state**, in the commit that renders the page, whether or not its own slot
  changed. A navigation that leaves the state as it was (no state before and
  after, the same primitive, the reader's own value passed back) renders
  none. An object-valued slot keeps its identity when the navigation carries
  the reader's value forward or a server action changes another slot, so
  effects and memoized children keyed on it do not run; before, a change to
  any slot handed readers of object-valued slots a new object.
  An equal object that is not the one the reader holds is still a new value.
- **A server action's state is added to what readers show**; it no longer
  re-reads the entry. Before, the action's update also made readers pick up
  an earlier `Def.write()`.
- **A reader outside the router's tree returns `undefined`.** The hook reads
  the entry its router has on screen (the provider every rango app renders
  under). Rendered with no provider, in a separate `createRoot` or bare in a
  unit test, there is no such entry; before, it read `history.state`. Use
  `Def.read()` there, or `renderRoute` in a test.
- **The `__rsc_locationstate` window event is gone.** It was internal and
  undocumented; code that listened for it or dispatched it gets nothing.

`usePathname()` and `useSearchParams()` on back/forward are the entry above
([#1031](https://github.com/rangojs/rango/issues/1031)): they no longer
change at the `popstate` event either.

On hydration nothing changes: a reader with no stored state renders once, and
one with state renders `undefined` and then the value.

In unit tests, `renderRoute` delivers location state the same way, so a
component can be tested across a pending navigation. `router.navigate()` takes
`state` and `replace` next to `loaders`: `state` pushes an entry carrying it,
`replace: true` replaces the current one, and with neither history is left
alone (`navigate(url)` and `navigate(url, { replace: false })` are the same
call).

```tsx
await router.navigate("/products?page=2", {
  state: [CarriedProducts(onScreen)],
  loaders: [[ProductsLoader, pending]], // a Promise the test resolves later
});
expect(getAllByRole("listitem")).toHaveLength(onScreen.length); // still page 1
```

A `popstate` event on `window` is a back/forward onto the entry
`history.state` holds (`history.replaceState(entry, "")` first): readers take
that entry as it is. A test that dispatched `__rsc_locationstate` itself has
to go through one of these instead, and a test that rendered a
`useLocationState` component without `renderRoute` has to render it through
`renderRoute`.

### Fixed: back/forward to an entry of the same route restores that entry's page after the history cache dropped it ([#1030](https://github.com/rangojs/rango/issues/1030))

Going back or forward to a history entry on the same route that differs only
in its search params left the wrong page on screen once the entry was no
longer in the client's history cache (20 entries by default). The URL and the entry's
location state changed; the content stayed the page being left. A "load more"
list (`?page=N`) longer than the cache showed it: Back to page 3 from page 24
kept page 24's items under page 3's URL.

| Back to `?page=3` from `?page=24`, entry no longer cached | URL       | Page on screen     |
| --------------------------------------------------------- | --------- | ------------------ |
| Before                                                    | `?page=3` | page 24            |
| Now                                                       | `?page=3` | page 3 (refetched) |

The refetch told the server the client was already on the target URL (the
address bar has moved by the time a back/forward is handled), so the server
found nothing to re-render. It is now told the page actually on screen. A
cached entry, and an entry on a different route, restored correctly before
and are unchanged. So did an entry whose page the app had prefetched within
`prefetchCacheTTL`: its return is served from the prefetch cache without
asking the server, so with link prefetching on the wrong page showed only
once that had expired. Nothing to adopt.

### Fixed: `useLocationState` no longer causes a hydration mismatch when its reader hydrates inside `<Suspense>` ([#1017](https://github.com/rangojs/rango/pull/1017))

After a reload or a back/forward navigation, `history.state` still holds the
location state. The server cannot see it and renders the reader with
`undefined`. A reader at the top of the tree hydrated with `undefined` too and
picked the stored value up afterwards. A reader inside a `<Suspense>` boundary
that hydrated after the root did not: its hydrating render returned the stored
value, React reported a mismatch (`Minified React error #418` in production)
and re-rendered the boundary on the client (#992).

Every hydrating render of `useLocationState` now returns `undefined`, wherever
the reader sits, and the stored value appears on the next render.

| Reader                                             | Hydrating render before | Hydrating render now |
| -------------------------------------------------- | ----------------------- | -------------------- |
| Hydrates with the root                             | `undefined`             | unchanged            |
| Inside a `<Suspense>` that hydrates after the root | the stored value        | `undefined`          |
| Mounted on the client (a navigation, not a reload) | the stored value        | unchanged            |

Nothing to change in app code. A late-hydrating reader takes one extra render,
as readers that hydrate with the root always did. Flash state behaves the same
way and is still cleared after it is read once.

### Added: `renderRoute({ hydrate: true })` hydrates the tree instead of mounting it ([#1017](https://github.com/rangojs/rango/pull/1017))

`renderRoute` from `@rangojs/router/testing/dom` mounted with `createRoot`, so
a test could not see what a hook renders on the server or while hydrating. With
`hydrate: true` it renders the same element to HTML first, puts that HTML in
the container, and hydrates it. The result gains `serverHtml` and
`recoverableErrors`, the hydration errors React reported:

```tsx
const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
  [{ path: "/grid", Component: Grid }],
  { hydrate: true, locationState: [[GridState, { count: 3 }]] },
);
expect(serverHtml).toContain(">0<"); // the server never sees history.state
expect(recoverableErrors).toEqual([]); // no hydration mismatch
expect(getByTestId("count").textContent).toBe("3");
```

- The server pass runs with `window` and `document` removed, so a
  `typeof window` branch takes its server side.
- Hydrate mode sets `data-hydrated` on `<html>` in an effect, as the production
  root does, and removes it on unmount. A `<Suspense>` boundary that hydrates
  in a later pass is therefore "late" the way it is in a real document.
- A global that stays defined in the server pass (`history`, `localStorage`,
  `navigator`) reads the same in both passes. A hook that reads one outside a
  server snapshot can pass here and still mismatch in real SSR.
- Content that suspends in the server pass is emitted as its `<Suspense>`
  fallback and client-rendered; React reports that in `recoverableErrors`.
- An attribute-only mismatch is not a recoverable error. React keeps the
  server attribute and only logs it.
- It needs `@testing-library/react` 16.2.0 or later and throws on older
  versions, which do not report hydration errors.

Without `hydrate` nothing changes.

### Fixed: a partial request ignores a `Referer` from another origin as its navigation context ([#1019](https://github.com/rangojs/rango/pull/1019))

A partial (navigation) request tells the server which page it is leaving. The
rango client sends that in `X-RSC-Router-Client-Path`. A request without the
header fell back to `Referer`, and only the pathname was matched:
`Referer: https://other.example/product/42` was read as `/product/42` on this
app, so the segment diff, the intercept and `from` were chosen for a page the
visitor was never on (#1005).

The fallback now accepts a `Referer` only when it is on the request's own
origin (scheme, host and port). Otherwise the request has no navigation
context and gets the full match; PPR replay reports
`BYPASS; reason=no-navigation-context`.

| Partial request                                      | Before                                  | Now                               |
| ---------------------------------------------------- | --------------------------------------- | --------------------------------- |
| `X-RSC-Router-Client-Path` present                   | header used                             | unchanged                         |
| no header, same-origin or relative `Referer`         | `Referer` used                          | unchanged                         |
| no header, `Referer` on another host, port or scheme | pathname matched as a route of this app | no navigation context, full match |
| no header, `Referer` that does not parse             | no navigation context                   | unchanged                         |

Nothing changes for navigations made by the rango client, which always sends
the header. `X-Forwarded-Host` and `X-Forwarded-Proto` are not consulted, as
with `originCheck`: behind a proxy that hands the app an internal URL, a
header-less partial request whose `Referer` is on the public origin now takes
the full match.

### Fixed: on a `ppr` route, a loader's handle pushes come from the same run as its data on every replay of the shell ([#1001](https://github.com/rangojs/rango/issues/1001), [#1003](https://github.com/rangojs/rango/issues/1003))

A loader can push handle values next to the data it returns
(`ctx.use(Meta)({ title })`, a breadcrumb, a note). On a `ppr` route the shell
keeps both for an `ssr: false` loader: its data as a pin, its settled pushes
in the recorded handler layer. A replay of the shell decided the two
separately. The data followed the pin. The pushes followed the kind of
request: a document HIT kept the shell's, a client navigation took the ones
the loader made on that navigation. So a soft navigation to a page could show
a title that did not belong to the data under it, and differ from a reload of
the same page.

Both now follow the pin. Where a replay serves a loader's data from the
shell, it shows the shell's pushes for it; where the loader runs, or reads its
own `cache()` entry, it shows that run's or that entry's pushes.

```tsx
const PriceNote = createHandle<string>();

const Price = createLoader(async (ctx) => {
  const price = await db.price(ctx.params.id);
  ctx.use(PriceNote)(price.label);
  return { price, related: db.related(ctx.params.id) }; // a promise: runs on every replay
});

path("/product/:id", ProductPage, { name: "product", ppr: true }, () => [
  loader(Price, { ssr: false }),
]);
```

| Replay of the shell of `/product/42`, after the price changed                                               | Before                                                | Now                                |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| Document HIT                                                                                                | captured price, captured note                         | unchanged                          |
| Client navigation or prefetch that replays the shell (`x-rango-ppr-replay: HIT`)                            | captured price, **new** note (#1003)                  | captured price, captured note      |
| The same, when the route's own `cache()` missed and the shell supplied the match                            | captured price, **new** note                          | captured price, captured note      |
| Client navigation, `ssr: false` loader with its own `cache()` that pushes a deferred (promise) value        | settled push shown, deferred push **missing** (#1001) | both shown, as on the document HIT |
| Document HIT of a shell stored without loader pins (over `ppr.maxSnapshotBytes`)                            | new price, **captured** note                          | new price, new note                |
| The same, for a note pushed by a loader the `ssr: false` loader awaits with `ctx.use()`                     | new data, **captured** note                           | new data, new note                 |
| Replay of a shell without pins when the loader's run makes no push                                          | new price, **captured** note                          | new price, no note                 |
| Replay of a shell without pins, loader with its own `cache()` whose entry is newer than the shell           | entry's price, **shell's** note                       | entry's price, entry's note        |
| `ppr` route under a route `cache()`, document request that hits the route record and the loader's own entry | entry's price, **record's** note                      | entry's price, entry's note        |
| Any replay, pinned loader that pushed no note at capture and pushes one when it runs on the replay          | captured price, **new** note                          | captured price, no note            |
| Replay of a shell without pins, loader with its own `cache()` whose entry was stored without its pushes     | entry's price, **shell's** note                       | entry's price, no note             |
| Client navigation that replays a shell captured by a navigation alone (no pins), loader pushes on its run   | new price, new note                                   | unchanged                          |
| Loader without `ssr: false` (a hole)                                                                        | its run's or its entry's data and pushes              | unchanged                          |

Nothing to change in app code, and nothing stored changes shape: shell
entries, route `cache()` records and loader `cache()` entries written by
earlier versions are read as they are, and take the new behavior on the next
request.

What an app that never saw these bugs can notice:

- On a `ppr` route with an `ssr: false` loader that returns a promise (so it
  runs on every replay), a client navigation that replays the shell now shows
  the pushes the shell captured, not the ones that navigation's run made. The
  data on that navigation was already the captured data; the pushes now match
  it. They change when the shell is recaptured (TTL/SWR or a tag), or make the
  value live: push it from a loader without `ssr: false`, or push a promise.
- A pinned loader's settled pushes are exactly the ones its capture made. A
  loader that pushes behind a condition shows the capture's answer on every
  replay of that shell, a push or none. Before, a push it made only on the
  replay showed next to the captured data. A deferred (promise) push is still
  delivered on every replay.
- When a shell is stored without loader pins, a run that pushes nothing now
  decides the handle output on a document HIT too.
- Handle pushes keep the order the loader made them in, wherever a run
  replaces recorded copies of them (a shell without pins, a `"use cache"` or
  loader `cache()` replay followed by a live run). A loader that pushes,
  awaits another loader that pushes, and pushes again shows
  `[own, other, own]`, the order an uncached render and its own cache entry
  give. Before, such a run put the loader's own pushes next to each other
  (`[own, own, other]`).
- A loader `cache()` entry that was stored without its pushes shows none on
  a replay of a shell without pins, where the shell's copy used to stay. Such
  an entry is written when another loader started the cached loader first
  (see "Not fixed here", below) or when its handle encode timed out. It refills with its
  pushes on its next miss.
- A corner that got worse: a shell entry that lost one loader pin but not all
  of them (a pin that failed to encode or decode) shows, on a document HIT,
  the live push of a loader that a still-pinned `ssr: false` loader awaits
  with `ctx.use()`, next to that loader's captured data. Before, a document
  HIT kept the captured push there; a client navigation already showed the
  live one. Registering the awaited loader on the route with
  `loader(Dep, { ssr: false })` gives it a pin of its own.

Not fixed here, by design (#1002): a loader that reads a `cache()`-bound
loader with `ctx.use()` before that binding starts (a loader declared ahead
of it, a parent layout) runs it live while the binding serves its cache
entry, so the page can show the entry's data next to the live run's push.
Declare the cached loader first, or read it from the handler, to keep them
together.

### Fixed: a document served from a PPR shell hydrates with the handle data the shell was rendered from ([#1035](https://github.com/rangojs/rango/issues/1035))

On a `ppr` route, a handle value an `ssr: false` loader pushed as a promise
broke hydration on every shell HIT: React error #418 in production,
"Hydration failed because the server rendered HTML didn't match the client"
in dev. The MISS that rendered the page first was clean.

```tsx
const Notes = createHandle<string>();

const Product = createLoader(async (ctx) => {
  const product = await db.product(ctx.params.id);
  ctx.use(Notes)(product.name);
  ctx.use(Notes)(db.stockNote(product.id)); // a promise: a deferred push
  return { product };
});

path("/product/:id", ProductPage, { name: "product", ppr: true }, () => [
  loader(Product, { ssr: false }, () => [cache({ ttl: 300 })]),
]);

// A client component in the page:
function NoteList() {
  return (
    <ul>
      {useHandle(Notes)
        .flat()
        .map((note, i) => (
          <li key={i}>{note}</li>
        ))}
    </ul>
  );
}
```

The shell's HTML had a second, empty `<li>`, and the HIT's data had the
note's text in it, or one row fewer, depending on timing.

The rule now: **a promise pushed from a loader is live and is never in a
shell. To have a value in the shell's HTML, push it settled (await it) from
the `ssr: false` loader, or push it from the handler.**

Three things changed, from the narrowest to the widest:

**(a) What is in a shell's HTML** changes only for promise pushes of
`ssr: false` loaders and of the loaders they await: `push(promise)`, or a
pushed value that holds a promise. The capture rendered an element for such
a push although its record does not keep it: empty when the loader's
`cache()` entry replayed it, holding the capture's value (for every visitor)
when the loader's body ran. It renders none now. Nothing changes for a
loader without `ssr: false`: it never ran at capture, so nothing of it was
ever in a shell.

**(b) On a shell HIT, every loader push made during the request arrives
after hydration**, a live-lane loader's included. It used to race: a push
was in the data the page hydrated with when the loader got to it before the
document's handle data was read, and arrived after hydration otherwise. The
page now hydrates with exactly the handle data the shell's HTML was rendered
from (the handlers' pushes and the settled pushes of the loaders that ran at
capture), and the request's own pushes follow as a normal `useHandle`
update.

**(c) `useHandle`, on every document, `ppr` or not:** a reader that React is
hydrating reads the handle data its HTML was rendered from, wherever its
boundary hydrates, and takes the newer data right after. Before, a reader
inside a boundary that hydrates after the rest of the page (the `loading()`
or `<Suspense>` of a loader) read the newest data, which could already hold
a push its HTML was rendered without: a loader push made after an `await`,
read inside that loader's own boundary, was a hydration error on a normal
document.

| Shell HIT of a `ppr` route                                                                        | Before                                                                         | Now                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| A promise push by an `ssr: false` loader with its own `cache()`                                   | an empty element in the HTML, hydration error                                  | not in the HTML; shown right after hydration           |
| A promise push by an `ssr: false` loader without `cache()`                                        | the capture's value baked into the HTML, the current one in the data: mismatch | not in the HTML; the current value, after hydration    |
| A push that holds a promise (`{ title, extra: promise }`) by an `ssr: false` loader               | an element with the capture's fields in the HTML, the current ones in the data | not in the HTML; shown right after hydration           |
| A push by a loader without `ssr: false`, made before its first `await`, read outside its boundary | in the data, not in the HTML: hydration error                                  | shown right after hydration                            |
| The same push, read inside the loader's `loading()` / `<Suspense>`                                | in the boundary's HTML                                                         | shown right after the boundary hydrates                |
| A push by a loader without `ssr: false`, made after an `await`, read inside its boundary          | hydration error (on a document without a shell too)                            | shown right after the boundary hydrates                |
| A shell stored without loader pins (over `ppr.maxSnapshotBytes`)                                  | the capture's push in the HTML, the run's in the data: mismatch                | hydrates with the capture's push, then shows the run's |
| Handler pushes, settled pushes of a pinned `ssr: false` loader                                    | in the HTML and in the data                                                    | unchanged                                              |
| Document MISS, a route without `ppr`, a client navigation: what the HTML and the data hold        | every push before the handler barrier, a deferred one resolved                 | unchanged                                              |

The app change, for a value that has to be in the shell's HTML (a crawler,
the first paint), is one line:

```ts
ctx.use(Notes)(db.stockNote(id)); // a promise: live, after hydration on a HIT
ctx.use(Notes)(await db.stockNote(id)); // settled: baked into the shell
```

Nothing stored changes shape. A router upgrade changes an app's cache
versions (a dependency changed), so no shell captured before the upgrade is
served after it. An app that sets `createRouter({ version })` itself and
keeps the value keeps its shells: one captured before the upgrade still has
the extra element in its HTML and fails hydration until it is recaptured
(its TTL/SWR, or a tag).

What an existing app can notice, in the same order:

- **(a)** A value an `ssr: false` loader pushes as a promise was in a HIT's
  HTML when the loader's body ran at capture (frozen there, for every
  visitor). It is now in the HTML of a document MISS and of a route without
  `ppr` only, and appears right after hydration on a HIT. A crawler that
  reads a HIT's HTML does not see it. Await it before pushing (above) to
  bake it.
- **(b)** A live-lane loader's push made before its first `await` was in a
  HIT's hydration data. It now arrives after hydration, like a push made
  after an `await`: there is one frame of the page without it, where it
  used to be a hydration error (read outside the loader's boundary) or
  already in the boundary's HTML (read inside it).
- **(b)** A shell stored without loader pins shows the capture's handle
  values until hydration, then the run's. Its loader DATA still differs from
  the HTML on hydration, as before (the documented drift of an entry over
  `ppr.maxSnapshotBytes`).
- **(c)** A `useHandle` reader inside a `<Suspense>` or `loading()`
  boundary renders once more after it hydrates when handle data arrived
  between the page's hydration and its own. A reader that hydrates with
  nothing new renders exactly as often as before.
- A capture still waits for a deferred loader push to settle, within
  `ppr.captureTimeout`, and stores no shell when it does not, as before. It
  no longer renders the value.

For tests: `serveShellRequest` (`@rangojs/router/testing/flight`) gains
`result.readHandles()`, the response's handle data as the browser reads it,
`{ hydration, late }`. A HIT's Flight payload now carries the
handle state twice (what it hydrates with, and the state after), so a test
that matched a pushed value in `result.flight` and expected it once reads
`readHandles()` instead. `renderRoute` (`@rangojs/router/testing/dom`) gains
`lateHandles`: handle values applied once the root has hydrated, to test
that a reader hydrates with the document's values.

## 0.20.0 (2026-10-03)

### Breaking: the default `clientChunks` strategy splits `app/routes/<id>` per route instead of one `app-routes` group ([#1023](https://github.com/rangojs/rango/pull/1023))

The built-in strategy keys a client component's group on the segment after
the first route-root marker (`routes`, `pages`, `features`, `app`, …). `app`
is in that list for Next-style `app/<segment>/` layouts, so in a project that
uses `app/` as its source root every route under `app/routes/` landed in one
`app-routes` group (#1022). A group is the loading unit: plugin-rsc imports
the group's module to resolve any one member, so rendering one component
downloads every component in its group. In those projects every route
downloaded every other route's client code.

An `app/` directly followed by another marker that has a directory after it
is now treated as a source root, and the inner marker keys the group. In every
other position `app/` is the route root, as before. Only `app` defers this
way; `routes/view/<sub>/` keeps `view` as the route id.

| Path                                       | Before           | After            |
| ------------------------------------------ | ---------------- | ---------------- |
| `app/routes/product/Gallery.tsx`           | `app-routes`     | `app-product`    |
| `app/routes/product/components/Thumbs.tsx` | `app-routes`     | `app-product`    |
| `app/features/auth/LoginForm.tsx`          | `app-features`   | `app-auth`       |
| `app/pages/cart/Cart.tsx`                  | `app-pages`      | `app-cart`       |
| `src/app/routes/cart/Cart.tsx`             | `app-routes`     | `app-cart`       |
| `src/routes/product/Gallery.tsx`           | `app-product`    | unchanged        |
| `src/pages/product/Gallery.tsx`            | `app-product`    | unchanged        |
| `app/dashboard/widgets/Chart.tsx` (Next)   | `app-dashboard`  | unchanged        |
| `app/features/page.tsx` (Next, file)       | `app-features`   | unchanged        |
| `app/routes/Layout.tsx` (no route dir)     | `app-routes`     | unchanged        |
| `app/routes/products.$id.tsx` (flat files) | `app-routes`     | unchanged        |
| `app/app/routes/x/W.tsx`                   | `app-routes`     | unchanged        |
| `app/components/Header.tsx`                | `app-components` | unchanged        |
| `src/components/Button.tsx`                | default group    | unchanged        |
| `app/routes/cart/X.tsx`                    | `app-routes`     | `app-cart`       |
| `app/features/cart/Z.tsx`                  | `app-features`   | `app-cart`       |
| `src/routes/cart/Y.tsx`                    | `app-cart`       | `app-cart`       |
| `app/routes/components/C.tsx`              | `app-routes`     | `app-components` |

The same route id under different markers is one group, and a group is the
loading unit. The last four rows were three groups before; now
`app/routes/cart/`, `app/features/cart/` and `src/routes/cart/` share
`app-cart`, so rendering any of them downloads all three. A route folder named
`components` (`app/routes/components/`) joins the shared `app/components/`
group. Rename the folder or use a `clientChunks` function if that pooling is
unwanted.

`app/components/` keeps its own `app-components` group, apart from every route
group. Returning the default grouping instead would put it in the router's
`serverChunk` group, which holds every other unmarked client module too.

Files directly in `app/routes/` (the React Router / Remix flat-file layout,
e.g. `app/routes/products.$id.tsx`) have no route directory after the marker,
so they still share one `app-routes` group and load as one unit; a
`clientChunks` function can split them per file. The deferral applies once:
`app/app/routes/<id>/` still keys on the inner `app` and pools as `app-routes`.

What changes for you: chunk file names are hashed, but the group name prefixes
them (`app-routes-<hash>.js` becomes `app-product-<hash>.js`, …). Update a
bundle-size check or CDN rule keyed on `app-routes-*`, and a `clientChunks`
function that compares `directoryClientChunks(meta)` with `"app-routes"`. A
Next-style project with a top-level route folder named after a marker that holds
subdirectories (`app/features/<sub>/`) now groups by `<sub>`; pass a
`clientChunks` function to keep the old grouping. The existing apps in this
repository have no `app/` directory, so their grouping is unchanged; only the
`src/app/` fixtures added for this fix (mini, cloudflare-basic) use one.

`DEBUG=rango:chunks vite build` now also logs one line per emitted client
group at the end of the client build, with its client-reference count and the
size of its chunk:

```
rango:chunks group app-product: 4 client reference(s), 48211 B (14020 B gzip) -> assets/app-product-Bx1.js
```

The `ClientChunks` JSDoc and `docs/client-chunking.md` now state that rendering
any member of a group downloads the whole group's chunk.

### Fixed: an unknown `headScripts` value throws instead of running as `"preinit"` or `"preload"` ([#1024](https://github.com/rangojs/rango/pull/1024), [#1027](https://github.com/rangojs/rango/pull/1027))

`headScripts` takes `"preinit"` (the default) or `"preload"`. Any other value,
such as the typo `"prenit"`, used to be accepted silently. It now throws in
both places the value is read:

| Where you pass it                                                           | Before                        | Now                                    |
| --------------------------------------------------------------------------- | ----------------------------- | -------------------------------------- |
| `rango({ headScripts })`                                                    | ran as `"preinit"`            | throws when the SSR entry is generated |
| a custom SSR entry: `createSSRHandler` / `createShellCaptureHandler` `deps` | ran the inline bootstrap path | throws when the handler is created     |

```
rango({ headScripts }) must be "preinit" or "preload", received "prenit"
[ssr] headScripts must be "preinit" or "preload", received "prenit"
```

Nothing changes for a config that omits the option or passes one of the two
values. A custom SSR entry that leaves `headScripts` undefined keeps the
inline bootstrap, as before.

### Fixed: the client entry's `modulepreload` is fetched at default priority after the head chunk scripts, so hydration doesn't wait behind images ([#1026](https://github.com/rangojs/rango/pull/1026))

With `headScripts: "preinit"` (the default), React writes the browser entry's
preload hint as `<link rel="modulepreload" fetchPriority="low">`, ahead of the
head chunk scripts. React hard-codes that priority for `bootstrapModules`
(react-dom 19.3.0 `react-dom-server.edge.production.js:546`) and claims the
URL (`:565`), so no `preloadModule` or `preinitModule` call can replace it.
Chromium fetches the hint at Low. Once it raises in-viewport images to High
after the first layout, the entry queues behind them, and hydration waits for
a few-hundred-byte file long after the head chunk scripts it imports have
arrived (#1025).

The SSR handler now rewrites that one tag, in the live HTML stream and in the
stored PPR shell prelude: it drops `fetchPriority="low"` and moves the tag
after the head chunk scripts and preloads React writes right behind it, ahead
of your own head content (`<title>`, `<meta>`, inline scripts and styles).
The request nonce, the executing `id="_R_"` script,
React's URL claim, PPR resume, and the single entry fetch stay as they were.
Nothing to change in your config. The production document goes from:

```html
<head>
  <link rel="stylesheet" href="/assets/entry-Bv9651rI.css" />
  <link
    rel="modulepreload"
    fetchpriority="low"
    href="/assets/index-xuT08BmS.js"
  />
  <script src="/assets/entry.rsc--Kjc-IQx.js" type="module" async=""></script>
  <script src="/assets/react-CiYhaMbR.js" type="module" async=""></script>
  <script src="/assets/router-CQUOyATP.js" type="module" async=""></script>
</head>
```

to:

```html
<head>
  <link rel="stylesheet" href="/assets/entry-Bv9651rI.css" />
  <script src="/assets/entry.rsc--Kjc-IQx.js" type="module" async=""></script>
  <script src="/assets/react-CiYhaMbR.js" type="module" async=""></script>
  <script src="/assets/router-CQUOyATP.js" type="module" async=""></script>
  <link rel="modulepreload" href="/assets/index-xuT08BmS.js" />
</head>
```

(Trimmed from the measured fixture: `crossorigin`, `data-precedence`, the
meta tags and the other head chunks are left out. The fixture has no head
content of its own after the chunks, so there the tag closes `<head>`.)

This is a trade-off. Image pages where the Low entry gated hydration
hydrate 0.15 to 3.3 s earlier (4 of the 12 image cells); the other image cells
are unchanged. Text-only pages served over a priority-honouring HTTP/2 link
hydrate or take the first click 12 to 56 ms later (at most 2.5%). Without the attribute, Chromium fetches
the hint at High. As the last High request, it is sent after the head chunks:
the HTTP/2 server sends streams of equal priority first in, first out, so the
346-byte entry arrives with the last head chunk instead of before it. Placing
the hint first instead (High, where React writes it) took one of HTTP/1.1's
six connections ahead of the react chunk: on image pages over HTTP/1.1 that
measured LCP +84 ms (Fast 4G) and hydration +91 ms (Slow 4G), so the tag
moves.

Measured with Chromium 153 through CDP, 20 interleaved runs per variant and
cell, 36 cells: image, text and text+CSS pages; HTTP/1.1 and HTTP/2; six link
profiles. The fixture has a 346-byte entry, ten head chunk scripts of about
304 KB gzip, and, on the image page, a 342 KB hero plus 12 thumbnails above the
fold. `relay-*` profiles run through a link emulator that keeps the server's
priority order; the others use DevTools throttling. Median change, after minus
before, in ms, with 95% CIs:

| Page / protocol / link   | Hydration                   | First click                 | LCP                    |
| ------------------------ | --------------------------- | --------------------------- | ---------------------- |
| images / h1 / Fast 4G    | -912 [-915, -908] (-47%)    | -906 [-913, -904] (-47%)    | -160 [-172, -150]      |
| images / h1 / relay Fast | -884 [-894, -870] (-55%)    | -860 [-883, -845] (-53%)    | -96 [-122, -60]        |
| images / h2 / relay Slow | -3321 [-3498, -3315] (-43%) | -3333 [-3452, -3261] (-43%) | -322 [-1040, 142] n.s. |
| images / h2 / relay Fast | -153 [-157, -137] (-14%)    | -158 [-167, -150] (-14%)    | +22 [-32, 86] n.s.     |
| text / h2 / relay Slow   | +56 [4, 58] (+2.5%)         | +4 [-2, 42] n.s.            | -14 [-16, -12]         |
| text / h2 / relay Fast   | +34 [-1, 53] n.s.           | +12 [3, 35] (+2.0%)         | -4 [-4, 0] n.s.        |

- No FCP or LCP regression is significant in any of the 36 cells. The other
  significant regressions are +9 ms hydration on text / h1 / Slow 4G
  (CI [2, 109], +0.3%) and +2 ms first click on text+CSS / h1 with no
  throttling at 1x CPU (CI [1, 4]).
- CDP confirms the priority change: the entry request is `Low` (initial and
  final) in all 1440 runs before and `High` in all 1440 runs after, with
  exactly one entry request per run in both.
- Limits: one machine (Apple M5 Pro), loopback, emulated links with no TCP slow
  start, loss or jitter, one synthetic fixture. The HTTP/2 server is Node's
  `http2` (nghttp2), which honours Chromium's priorities and sends
  equal-priority streams first in, first out. CDNs schedule differently, and
  the text-page cost depends on that scheduling.
- `headScripts: "preload"` and custom SSR entries without `headScripts` keep
  the inline `import()` bootstrap, which has no entry hint: unchanged.
- The tag is only ever placed between two complete tags React wrote: an
  inline `<script>` or `<style>` in your `<head>` is never scanned, so text
  such as `"<body>"` or `"</head>"` inside it can't attract the tag.

## 0.19.1 (2026-10-01)

### Breaking: `"use cache"` refuses a loader value read with `ctx.use()` or `getRequestContext().use()` when the loader's run read `cookies()`, whichever code started it ([#1014](https://github.com/rangojs/rango/pull/1014))

A `"use cache"` function that reads a loader threw when the loader's body
read `cookies()`, `headers()`, `ctx.request.headers`, the theme or a
`{ cache: false }` variable, but only when the cached function was the first
to read that loader in the request (#1011). When a handler's `ctx.use()` or
`getRequestContext().use()`, the route's `loader()` binding or a parent
layout's binding started it first, the cached function got the request's
memoized value unchecked. The entry, keyed by route, URL and args, stored the
first visitor's value and served it to every later visitor of that URL.

```ts
export const UserLoader = createLoader(
  async () => `user-${cookies().get("u")?.value}`,
);

async function greetingFor(ctx: HandlerContext) {
  "use cache";
  return `greeting:${await ctx.use(UserLoader)}`;
}

path("/b", async (ctx) => [await ctx.use(UserLoader), await greetingFor(ctx)]);
path(
  "/c",
  (ctx) => greetingFor(ctx),
  {},
  () => [loader(UserLoader)],
);

// Before: visitor b on /b or /c is served "greeting:user-a".
// After: greetingFor rejects with `cookies() cannot be called inside a
// "use cache" function. Loader "..." called it, and the cached function
// reads that loader's value. ...`, as it already did when it read first.
// The same holds when both reads use getRequestContext().use(UserLoader)
// (server actions and code without a handler ctx).

// Migration: read the loader outside and pass the value in; it becomes part
// of the key.
async function greetingFor(user: string) {
  "use cache";
  return `greeting:${user}`;
}
const greeting = await greetingFor(await ctx.use(UserLoader));
```

| The cached function reads a loader that read identity             | Before                                                                | After                                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| The cached function starts it                                     | throws                                                                | throws (unchanged)                                                                                |
| A handler, the route's or a parent layout's `loader()` started it | stores visitor a's value                                              | throws the same error once the value settles                                                      |
| A handler and the function both use `getRequestContext().use()`   | stores visitor a's value                                              | throws the same error once the value settles                                                      |
| It reads a loader that read (`ctx.use` chain)                     | stores visitor a's value                                              | throws, naming both loaders                                                                       |
| A loader `cache()` binding with a `key()` (MISS or HIT)           | stores visitor a's value                                              | throws                                                                                            |
| The read settles after the value (a nested promise in it)         | stores visitor a's value                                              | each visitor gets their own value; nothing is stored; `onError` reports a `cache-write` error     |
| The function calls `ctx.use()` and never awaits it                | stored the function's result (the loader value was not in it)         | nothing is stored (fails closed); `onError` reports a `cache-write` error; no unhandled rejection |
| On a `ppr` route                                                  | the render stored visitor a's value in the entry; the capture refused | the render fails (500, or the error boundary) for every visitor; no shell capture is scheduled    |
| The loader read no identity                                       | stored                                                                | stored (unchanged)                                                                                |
| A handler reads it under a route `cache()`, no `"use cache"`      | reads                                                                 | reads (unchanged)                                                                                 |

Three cases fail closed:

- The read refuses even when the cached function never uses the value
  (`await ctx.use(UserLoader)` and then returns something else). It can't
  tell, and the first-reader path throws there too.
- A refusal inside a nested `"use cache"` function also refuses every
  enclosing `"use cache"` function's write, even when the outer one catches
  the inner rejection: the outer entry would hold what the inner one read.
- A read whose result does not reach the cached value but settles before the
  entry is encoded (a handle push from the same loader whose promise reads
  `cookies()` later) also fails the write: the check cannot tell which value
  a late read feeds.

## 0.19.0 (2026-10-01)

Upgrading from 0.18: what to change. Each entry below has the details.

- **`transition({ when })` runs in the browser.**
  - Write the predicate inline in `urls()`, or export it from a `"use client"` module.
  - Read `from` / `to` (`url`, `params`, `routeName`, `state`) instead of `currentUrl` / `currentParams` / `ctx.get()`.
  - Read location state with `Def.read(to)`.
  - A server function now fails dev startup and the build.
- **`intercept({ when })` reads the same shape.**
  - `from.pathname` is now `from.url.pathname`.
  - `params` is now `to.params`.
- **Identity reads in cached code.**
  - `ctx.request.headers` and `getRequestContext().cookie()` / `.cookies()` now refuse where `cookies()` does: in a `"use cache"` body, in a handler under `cache()`, and in a `ppr` capture.
  - The same applies to a loader body that starts inside `"use cache"`, including a `{ cache: false }` `ctx.get()`.
  - Copy the value in middleware and include it in `key()`, read it in a live loader, or pass it into the `"use cache"` function.
- **Typed location state.**
  - `state` on `push()` / `replace()` / `<Link>` takes called entries (`[Def(value)]`).
  - In unit tests, key a definition with `withLocationStateKey()`.
- **Cache keys.** `cache({ key })` results (route, response route, and a loader's own `cache()`) are stored namespaced, and a nested `cache()` inherits `condition()` and `tags`. Stored key strings change, so entries on stores that don't version per build miss once.
- **PPR.** A hole always reads the cache store, never the shell's copy. Give a hole its own cache, or make it shell material.
- **Custom shell stores.** `ShellCacheEntry` lost fields nothing produced, and every entry field must round-trip.

### Breaking: a loader's own `cache({ key })` result is stored namespaced, so it can't name another loader's entry ([#1012](https://github.com/rangojs/rango/pull/1012))

A loader's own `cache({ key })` result was stored as the entry key verbatim
(#1009). The default loader key is `loader:<loaderId>:<host><path>`, and a
`key()` often returns request input, so a request could send a value equal
to another loader's key: a `key()` returning the `x-variant` header, sent
`loader:<AccountLoader id>:localhost/account`, read `AccountLoader`'s entry
(serving its data from the wrong loader) or, on a miss, overwrote it. Two
loaders whose `key()` returned the same value shared one entry, and a value
equal to a `"use cache"` key (`use-cache:<id>:...`, the same store item
family) named that entry. #991 closed this for route and response-route
keys; loader keys were left raw.

A loader's `key()` result is now stored as `loader:<loaderId>:key:` plus its
URI encoding, so it can't equal a default loader key, another loader's key,
or a `"use cache"` key:

```tsx
loader(ProductLoader, () => [
  cache({ ttl: 300, key: (ctx) => `product:${ctx.params.slug}` }),
]);
// Before: the entry key was "product:shoe".
// After:  it is "loader:<ProductLoader id>:key:product%3Ashoe".
```

A store `keyGenerator` result is stored as returned, as on routes, and the
default key is unchanged. Any `key()` or `keyGenerator` still declares
request identity (#972).

The breaking part: stored key strings change for loaders with a `key()`, so
those entries miss once. `CFCacheStore` versions its keys per build and
`MemorySegmentCacheStore` starts cold on restart; the one-time miss applies
to a `CFCacheStore` with a pinned `version`, to `VercelCacheStore` without
`version` and to custom `SegmentCacheStore`s that don't version their keys.
Tests that assert a loader's raw `key()` result as the store key need the
namespaced form.

Migration: nothing to change in `key()` functions. On `CFCacheStore` the
result is URI-encoded twice in the Cache API URL (here, then by the store),
so a reserved character such as `:` takes 5 bytes there; a 2 KB result of
reserved characters still caches (8 KB measured locally on workerd), but
keep request-derived keys short or hash them.

### Fixed: a prefetched intercept target opens the modal from a page where the intercept applies ([#1008](https://github.com/rangojs/rango/pull/1008))

A prefetch of a route an intercept targets, made from a page where the
intercept does not apply (its `when` returned false), was stored in the
prefetch slot every page shares. A later click on the same link from a page
where the intercept applies reused it and rendered the full page instead of
the modal, for the prefetch cache lifetime (#1007). The server marked a
response source-specific only when the intercept matched.

```tsx
intercept("@modal", "product", <ProductModal />, {
  when: ({ from }) => from.url.pathname === "/",
});

// On /about: <Link to="/product/a" prefetch="hover" /> is hovered (full page).
// Then on /: <Link to="/product/a" /> is clicked.
// Before: the full product page renders (the /about prefetch was reused).
// After: the modal opens over /.
```

Now partial (navigation and prefetch) responses for a route an intercept
targets carry `x-rsc-prefetch-scope: source`, matched or not, so the browser
keeps them per source page, and they get no prefetch `cache-control`. A route
no intercept targets keeps the shared entry. Document responses, and the full
payload a partial request without navigation context falls back to, do not
carry the header: they have no source page.

| Target route                                   | Before           | After                               |
| ---------------------------------------------- | ---------------- | ----------------------------------- |
| An intercept targets it and applies here       | per source       | per source                          |
| An intercept targets it, `when` false here     | shared (the bug) | per source                          |
| An intercept targets it, same-route navigation | shared (the bug) | per source                          |
| No intercept targets it                        | shared           | shared                              |
| Custom `revalidate()` reading `currentUrl`     | shared           | shared: use `prefetchKey=":source"` |

### Breaking: `ctx.request.headers` and `getRequestContext().cookie()` / `.cookies()` refuse where `cookies()` does ([#999](https://github.com/rangojs/rango/pull/999))

The identity guards stopped `cookies()`, `headers()`, the theme reads and a
`{ cache: false }` variable from reaching a shared entry, but three raw reads
went around them (#976): `ctx.request.headers` (the same `Request` in
handlers, middleware, loaders and `getRequestContext().request`) and
`getRequestContext().cookie()` / `.cookies()`. A `"use cache"` function keys
a `ctx` or a `Request` argument by its route and URL only, so a header read
in its body stored the first caller's value and served it to every later
caller. A handler under `cache()` or on a `ppr` route stored it in the
shared record or shell, and a loader's own `cache()` without `key()` stored
it in its entry.

Each of these reads now goes through the same guard as `cookies()`, with
the same scopes, order and error style:

```ts
// Before: the first caller's accept-language was stored in the entry.
// After: throws `ctx.request.headers cannot be read inside a "use cache"
// function`.
async function getGreeting(ctx: HandlerContext) {
  "use cache";
  return greet(ctx.request.headers.get("accept-language"));
}

// Migration: read it outside and pass it in; it becomes part of the key.
async function getGreeting(language: string | null) {
  "use cache";
  return greet(language);
}
const greeting = await getGreeting(ctx.request.headers.get("accept-language"));
```

| Where the read runs                                              | Before                      | After                                                               |
| ---------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| Middleware; a handler outside `cache()` and `ppr`; a live loader | reads                       | reads (unchanged)                                                   |
| A handler or layout under `cache()`                              | stored in the shared record | throws `... cannot be read inside a cache() boundary`               |
| A `"use cache"` body, and a loader it awaits                     | stored in the entry         | throws `... cannot be read inside a "use cache" function`           |
| A `ppr` capture render                                           | baked into the shell        | refuses the capture (once-per-key warning); the route keeps MISSing |
| A loader's own `cache()` without `key()`                         | stored in the entry         | the fill fails with the identity error and stores nothing           |

`ctx.request.clone()` returns a clone guarded the same way.
`new Request(ctx.request)` and `fetch(ctx.request)` never throw (the platform
copies the headers without calling the getter), but they are not guarded
either: the copy is a plain `Request`, and a fetch forwards the visitor's
`Cookie` and `Authorization`, so its response is per visitor. Don't make
either in a cached body. `console.log(ctx.request)` on Node reads no header
through the guard. `ctx.request` stays a real `Request` (the guard is an own,
non-enumerable `headers` getter on it, not a Proxy), and the router's own
header reads bypass it.

A cache's own `key()`, store `keyGenerator`, `condition()` and `tags()`
function, and `onError`, read request identity freely, in every scope above
and at capture: the value picks or labels the entry, or is only observed; it
is never rendered. A `"use cache"` body, a loader body or a segment render
they start is guarded as usual.

| Callback                                                 | Before                                                                                              | After                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| A route `key()`                                          | reads (a capture reuses the request's result)                                                       | reads (unchanged)          |
| A store `keyGenerator`, `condition()`, `tags()` function | `cookies()` / `headers()` refused a `ppr` capture (a capture resolves them again); raw reads passed | every identity read passes |
| `onError`                                                | `cookies()` / `headers()` refused a capture or threw in a cached scope; raw reads passed            | every identity read passes |

The breaking part: code that reads `ctx.request.headers` or
`getRequestContext().cookie()` / `.cookies()` in the scopes above now
throws or refuses the capture. The most common case is a handler under a
keyed `cache()` that renders the header its `key()` partitions by:

```tsx
// Before: the handler read the header directly.
// After: copy it in middleware; the key() keeps each value in its own record.
const Tier = createVar<string>();

middleware(
  async (ctx, next) => {
    ctx.set(Tier, ctx.request.headers.get("x-tier") ?? "free");
    return next();
  },
  () => [
    cache(
      {
        ttl: 300,
        key: (ctx) => `tier:${ctx.request.headers.get("x-tier") ?? "free"}`,
      },
      () => [path("/pricing", (ctx) => <Pricing tier={ctx.get(Tier)} />)],
    ),
  ],
);
```

Migration:

- `"use cache"`: read the header before the call and pass it in as an
  argument.
- A handler under `cache()` or on a `ppr` route: copy the value in
  middleware (`ctx.set()`) and include it in the `key()` or the store
  `keyGenerator`, or read it in a live loader (no `ssr: false`), which runs on
  every request, HITs included.
- A loader's own `cache()`: add a `key()` that includes the header.
- `getRequestContext().cookie()` / `.cookies()` were never on the public
  type; use `cookies()`, which answers the same way.

`getRequestContext().theme` has been guarded since 0.18.0 (#971).

### Breaking: `transition({ when })` runs in the browser, with `{ kind, from, to, isAction, action }` ([#1006](https://github.com/rangojs/rango/pull/1006))

`when` used to run on the server while the route resolved, so its decision
was frozen into whatever response carried it: a prefetch decided against the
page it fired from, not the page the click left (the prefetch caveat); a
`cache()` or prerender hit replayed a stored decision; a layout the
navigation kept never re-ran its `when` at all (#989). The decision also
changed the rendered tree, so a same-route navigation that flipped
`true -> false -> true` remounted the route and lost its component state
(#995).

`when` is now a browser predicate. It runs once per navigation, at the
first commit that presents the destination, with the committed location
being left (`from`) and the destination (`to`):

```ts
// Before: server-side, revalidate()-shaped args
transition({ when: ({ currentParams }) => currentParams?.n !== "b" });
transition({ when: (ctx) => ctx.get(KeepScroll) === true });

// After: inline in urls() (the build hoists it into a client module)
transition({ when: ({ from }) => from.params.n !== "b" });
// ...or read location state the Link pushed
transition({ when: ({ to }) => KeepScroll.read(to)?.keep === true });
```

- `from` / `to` are `{ url, params, routeName, state }`; `state` is the
  entry's `history.state`, read with `Def.read(location)` (a new overload
  that reads a snapshot and never clears flash state). `to` is `from` for
  `kind: "action"` and `kind: "revalidate"`.
- `kind` is `"push" | "replace" | "pop" | "action" | "revalidate"`;
  `isAction()` is the `revalidate()` matcher, and `action` carries
  `{ id, formData, result, error }` on action commits, the error-boundary
  commit included.
- The navigation holds only when every committed segment's `when` returns
  true, kept or re-sent (#989). `false` commits urgently, for every kind
  (navigations, actions, `refresh()` and stale revalidations): the
  `loading()` skeleton streams, and every `<ViewTransition>` class is set to
  `"none"` instead of removing the element, so nothing remounts (#995). A
  throw counts as `false` and is logged with `console.error`.
- `from.routeName` / `to.routeName` are typed from the generated route map
  (`DefaultRouteName`) and are `undefined` for an unnamed route or a hidden
  include scope; internal names never reach a predicate.
- It never runs on the document load, on progressive-enhancement paths, or
  on the server. A prefetch no longer decides anything.

In `urls()`, `when` must reach the browser: write it inline (the Vite
plugin hoists the literal passed to the router's `transition` into a
`"use client"` module; a free server binding, a server-only import,
`import()`, `import.meta` other than `import.meta.env`, or `this` /
`arguments` of the enclosing function is a build error that names it), or export
it from a `"use client"` module and import it. A server function or a
non-function fails dev startup, the build and HMR re-discovery with the
route name and pattern; a route discovered at runtime throws the same error
at render. `clientUrls()` accepts `when` inline. Handler and middleware
context (`get()`, `env`) does not exist in the browser: set location state
from the handler, middleware or a `Link` and read it from `to.state`.
Middleware-set location state reaches the predicate on a PPR replay HIT
too.

`runTransitionWhen(when, { kind, from, to, action })` from
`@rangojs/router/testing` builds the same context and returns
`{ applied, gatedOff, context }` (was `{ kept, dropped, whenContext, ctx }` over
a request). `renderRoute` decides `navigate()` as `kind: "push"` and the new
`router.refresh()` as `kind: "revalidate"`. In a Vitest project the hoist
and the validation do not run: an inline `when` stays a plain function.

### Breaking: `intercept({ when })` selectors read `from` / `to` locations ([#1006](https://github.com/rangojs/rango/pull/1006))

An intercept selector now sees the same location shape as
`transition({ when })`, without `state` (history state never reaches the
server):

```ts
// Before
intercept("@modal", ".product", ProductModal, {
  when: ({ from, params }) =>
    from.pathname === "/shop" && params.id !== "gift-card",
});

// After
intercept("@modal", ".product", ProductModal, {
  when: ({ from, to }) =>
    from.url.pathname === "/shop" && to.params.id !== "gift-card",
});
```

`from` and `to` are `{ url, params, routeName }` (`ServerRouteLocation`).
`from` is the page the navigation leaves, or, while an intercept is open, the
intercept's source page (the page under the modal), as `from` was before.
`from.params` are the source route's params, which the selector could not
read before; `fromRouteName` / `toRouteName` / the top-level `params` are
gone in favor of `from.routeName`, `to.routeName` and `to.params`.
`request`, `env` and `segments` are unchanged. A selector that throws no
longer fails the request: it does not intercept (the full page renders) and
the error is logged with `console.error` and the route name.

### Added: `transition: false` on a single navigation ([#1006](https://github.com/rangojs/rango/pull/1006))

`router.push(url, { transition: false })`, `router.replace(url, {
transition: false })` and `<Link transition={false}>` present that one
navigation the way a `when` returning `false` does: an urgent commit and no
view transition. No `when` predicate is called. Back/forward, action and
revalidation commits are not started by these calls and are unaffected.

### Breaking: a `"use cache"` entry carries the tags of the `"use cache"` functions it calls, so `updateTag()` of an inner tag evicts it ([#996](https://github.com/rangojs/rango/pull/996))

A `"use cache"` function that called another stored the inner value in its
own entry, but not the inner function's tags (#980). `updateTag()` or
`revalidateTag()` of an inner tag dropped the inner entry and left the outer
one serving the old inner value until it expired. The same-request check
from 0.18.0 did not see the outer call as tagged by it either, so a request
that invalidated the inner tag could still reuse an outer call it started
earlier.

```ts
async function getStock(sku: string) {
  "use cache";
  cacheTag("stock");
  return db.stock(sku);
}

async function getProductCard(sku: string) {
  "use cache";
  return { sku, stock: await getStock(sku) };
}

// Before: updateTag("stock") dropped getStock's entry; getProductCard's
// entry kept serving the old stock until it expired.
// After: getProductCard's entry is tagged "stock" too and goes with it.
```

The outer entry takes the inner call's tags whether the inner call ran, was
read from the store (its stored tags) or joined another call's execution. A
`"use cache"` component whose returned JSX renders a server component that
calls another `"use cache"` function takes that call's tags too: the call
runs while the value is encoded for the store write, after the body
returned. So does every entry above an intermediate call whose value holds
a nested call still running (`{ stock: getStock(sku) }`, unawaited). A
stale inner entry's background refresh adds nothing to the outer entry,
which holds the stale value. A route `cache()` record and a loader's own `cache()` entry
already stored the tags of the `"use cache"` reads inside them; nested
`"use cache"` now does the same.

The breaking part: an outer entry is evicted by every tag of the calls
inside it, so after an invalidation of an inner tag the outer function runs
again where it used to serve its entry. Entries written before this release
carry only their own tags until they expire or are rewritten.

### Breaking: `cache({ key })` results are stored namespaced, so a `key()` result can't name another record ([#991](https://github.com/rangojs/rango/pull/991))

A route or response-route `cache({ key })` result was stored as the record
key verbatim (#975). A record key has no route discriminator, and a `key()`
often returns request input, so a client could send a value equal to another
record's key and write one route's content under the other route's entry:
the header value `doc:<host>/pricing` returned raw by a `key()` on `/other`
named `/pricing`'s default-keyed record, and `gold|doc%3A<host>%2Fpricing`
named gold's nested `/pricing` record (#970). On a response route, the
header `json:<host>/api/b` made `/api/b` serve `/api/a`'s body.

Every `key()` result is now stored as `key:` plus its URI encoding, and a
default key inside a composed key is URI-encoded, so no `key()` result can
equal a default key or a composed key, and no two composed keys are equal:

```tsx
cache({ ttl: 300, key: (ctx) => `tier:${tierOf(ctx)}` }, () => [
  path("/pricing", PricingPage),
]);
// Before: the record key was "tier:gold".
// After:  it is "key:tier%3Agold"; nested, "key:tier%3Agold|key:v%3Aa" or
//         "key:tier%3Agold|doc%3A<host>%2Fpricing"; a response route's
//         entry is "response:key:tier%3Agold".
```

The same scheme keys route records, response-route entries, the `ppr` shell
partition (`<host><path>:shell|key%3Atier%253Agold`) and client navigation
replay. A `cache()` chain with no `key()` keeps its default key or store
`keyGenerator` result unchanged.

The breaking parts:

- Stored key strings change, so keyed entries miss once. `CFCacheStore` and
  shells on every store are versioned per build, and `MemorySegmentCacheStore`
  starts cold on restart, so for them a deploy is already cold. The one-time
  miss for existing keyed entries applies to `VercelCacheStore` without
  `version` and to any custom `SegmentCacheStore` that doesn't version its
  keys.
- Tests that assert raw keys need the namespaced form. `shellCacheKey(url,
searchParams, partition)` namespaces a `key()` result as production does, so
  a string `partition` now means a `key()` result. For a store `keyGenerator`
  partition, pass `{ generated: [result] }` (with `keys` for `key()` results
  alongside; the new `ShellCachePartition` type).

Migration: nothing to change in `key()` functions. The old advice to prefix
or encode request input in `key()` is no longer needed for isolation; a
readable prefix is still good practice, and normalizing to the values you
serve keeps the number of entries (and `ppr` shells) bounded.

### Breaking: a nested `cache()` inherits the enclosing `condition()` and `tags`, and an enclosing store's `keyGenerator` partitions it ([#991](https://github.com/rangojs/rango/pull/991))

A nested `cache()` took `condition` and `tags` from its own config only, and
an enclosing `cache({ store })`'s `keyGenerator` did not reach a nested
`cache()` on another store (#974):

- a request an outer `condition()` refused still read and wrote the nested
  record, and a `ppr` route under it served and captured a shell;
- `updateTag(outerTag)` left the nested records, and the shells built from
  them, in place;
- the nested store's records, and a `ppr` shell under them, were shared
  across the outer store's `keyGenerator` partitions (a locale, say).

Now `condition` combines with AND (an inner boundary caches only when every
enclosing `condition()` allows it; record reads, writes and the `ppr` shell
alike), `tags` combine by union (static and function forms), and each
enclosing no-`key()` scope on another store (the app-level store included)
adds its `keyGenerator` result to the nested record key and shell partition.
A result equal to the default key keeps its position as an empty part, and
when every one equals the default key the key is unchanged. `ttl`, `swr` and `store` still come from the nearest `cache()`,
and `cache(false)` is unchanged. A loader's own `cache()` and `"use cache"`
stay independent layers.

```tsx
cache({ condition: (ctx) => !isPreview(ctx), tags: ["catalog"] }, () => [
  cache({ ttl: 60, tags: ["prices"] }, () => [path("/prices", PricesPage)]),
]);
// Before: a preview request read and wrote the /prices record, which was
// tagged "prices" only, so updateTag("catalog") left it.
// After: a preview request renders /prices live, and the record is tagged
// "catalog" and "prices": updateTag("catalog") evicts it and its shells.
```

Migration: a nested `cache()` that relied on caching despite an outer
`condition()` needs to move out from under it. Records under a nested
`cache({ store })` whose outer store has a partitioning `keyGenerator` move
to new keys and miss once. Records whose key does not change (a nested chain
with no `key()`) and that were written before the upgrade keep only their own
tags until they expire: on a store that doesn't version its keys
(`VercelCacheStore` without `version`, a custom store), `updateTag(outerTag)`
won't evict them, so purge those records or set `version` when you deploy.

### Breaking: a PPR hole reads the cache store, never the shell's copy of a value ([#998](https://github.com/rangojs/rango/pull/998))

A hole is a live-lane loader (no `ssr: false`) read under `loading()` or an
inline `<Suspense>`, or a promise nested in an `ssr: false` loader's return.
It is dynamic or has its own cache; it never reads the shell snapshot.

Before, when an `ssr: false` loader read a `"use cache"` (or loader
`cache()`) entry during the capture, the shell stored that entry and a HIT
served it to every reader of the key, holes included. A live loader reading
the same `"use cache"` key, or a promise in the `ssr: false` loader's own
return calling it, showed the capture's value for the shell's whole
lifetime: past the entry's own ttl/swr, and past a `revalidateTag()` the same
request made.

Now the shell stores its recorded handler output and the `ssr: false`
loaders' baked containers, and nothing else. Every cache read on a HIT goes
to the store:

- a hole reading a key an `ssr: false` loader also read shows the store's
  current value once the entry refreshes, while the baked container keeps
  the captured one;
- an `ssr: false` loader that runs on a HIT reads the store too. One whose
  return holds promises runs on every HIT. So does every promise-free one on
  a page whose capture saw a loader push it could not record (a deferred
  push, or one holding a promise): that flag is per capture, so each such
  loader body runs in the background on each HIT, and its `"use cache"` and
  `cache()` reads are now real store reads there (a Cache API or KV read on
  `CFCacheStore`, which can start a background refresh of a stale entry).
  Its baked container paths still come from the shell, and so do its settled
  handle pushes, those replayed inside its body included: the prelude
  rendered them, so they stand and the settled pushes of the run are
  dropped. Its nested promises and deferred pushes carry the run's values.
- a loader the route registers on the live lane is a hole even when an
  `ssr: false` loader awaited it at capture, or awaits it on the HIT: its
  data and its handle pushes, and those of the loaders it awaits, carry its
  run's values on a HIT and on a client navigation, also when a
  recapture's `"use cache"` hit replayed them. A run that throws, or makes
  no push, shows none of the capture's pushes once its run ends; a hole
  slower than the handler barrier shows the shell's copy in the first
  snapshot until then. A hole with its own loader `cache()` that hits shows
  the pushes that entry recorded, none if it recorded none, matching the
  data it serves.
- a dependency the route does not register, awaited at capture by an
  `ssr: false` loader outside any live loader, is on neither lane: its
  settled handle pushes come from the shell on a HIT, as the prelude shows
  them, even when a live loader also awaits it, while its data carries the
  run's value. To keep its pushes live, declare it as its own `loader()` on
  the route.

If a hole needs a value that stays put, give it its own cache (a
`"use cache"` profile, a loader `cache()`), or make it shell material (a
promise-free `ssr: false` loader).

For custom stores and diagnostics: `ShellCacheEntry.snapshot` holds only
`"segment"` and `"loader"` records (the `"item"` member of the record-family
union is gone), so shell entries are smaller, and the HIT tail's
`ppr-tail` Server-Timing prints `records=segment:1` with no `pruned=item:N`
(`pruned=` now appears only when a navigation-only entry drops its loader
pins).

### Breaking: one identity-read guard; a loader body inside `"use cache"` refuses a non-cacheable `ctx.get()` ([#998](https://github.com/rangojs/rango/pull/998))

`cookies()`, `headers()`, the theme reads (`ctx.theme`,
`getRequestContext().theme`) and `ctx.get()` of a `{ cache: false }`
variable now go through one guard and refuse in the same places.

- A loader body entered inside a `"use cache"` function
  (`await ctx.use(Loader)` in the cached body) now throws on a non-cacheable
  `ctx.get()`, as it already did on `cookies()`, `headers()` and a theme
  read. Before, the read was allowed and the loader's value was stored in the
  `"use cache"` entry, under a key that did not include it, so the next
  caller got the first caller's value. Read the variable before calling the
  cached function and pass it in as an argument.
- During a PPR shell capture, an identity read refuses the capture first,
  inside a `"use cache"` body or a `cache()` boundary too, and throws the
  capture's error. Before, `cookies()`, `headers()` and a theme read there
  threw the `"use cache"` or `cache()` error without flagging the capture.
- A non-cacheable `ctx.get()` refused inside a `cache()` boundary now names
  a string key in its message, as the `"use cache"` refusal already did.
- A non-cacheable `ctx.get()` refused during a PPR capture now throws
  `ctx.get() for a non-cacheable variable "<key>" cannot be called while
capturing a shared shell` (the key named for a string key), where it threw
  `ctx.get() cannot be called while capturing a shared shell`, and the
  capture's refusal warning names the same surface. Update any test that
  matches the old text.

Unchanged: loader bodies may read identity under a route `cache()`, a live
loader reads it freely, `ctx.dynamic()` still opts a render out, and
`invalidateClientCache()`/`keepClientCache()` still only refuse inside a
cached scope and record nothing.

### Breaking: PPR shell types lose fields nothing produced, and custom stores round-trip every entry field ([#988](https://github.com/rangojs/rango/pull/988))

These public types change. What they drop, the built-in paths never produced.

- `PprReplayBypassReason` (`@rangojs/router/testing`) no longer has
  `stale-build-entry`. A partial navigation never reported it: a build-time
  shell never carries the doc segment record partial replay consumes, and a
  prerendered URL's partial is served from its prerender artifact first
  (`prerender-store`). Remove the member from any exhaustive `switch` or
  list over the reasons; `parsePprReplayStatus()` returns `null` for it.
- `ShellCaptureDebugEvent` (`debugShellCapture`) no longer has
  `bakeWaitMs`, and the console line no longer prints `bake=`. The capture
  waits for pushed handle promises and `ssr: false` loader containers in its
  record-first step, so the field measured about 0 ms. Read
  `recordSettleMs` (`record=`) instead: it covers the same wait.
- `ShellCacheEntry` (`@rangojs/router/cache`) makes `buildVersion` and
  `snapshot` required, and the `holes`/`runs` bits of a snapshot's loader
  records are required too. The capture always set `buildVersion` and the
  bits, and now stores `snapshot: []` when it recorded nothing. A custom
  `SegmentCacheStore` with its own `getShell`/`putShell` must return every
  field `putShell` received, `buildVersion` and `snapshot` included (the
  snapshot can be an empty array). An entry read back without them is no
  longer read through a fallback: `CFCacheStore` and `VercelCacheStore`
  treat a stored shell without `buildVersion` as malformed (a reported miss,
  and the entry is evicted). A loader record without its bits (one stored
  before they existed) still reads as carrying holes and runs its loader
  body on a HIT.
- The record-family union on `ShellCacheEntry.snapshot` no longer has
  `"response"`: a capture never records the response family. Drop the
  member from any `switch` over `record.family` in a custom store.
- `ShellDocumentRead.entry` (the result of the `@internal`
  `readShellDocument`) is now `ShellEntryHead`, the entry without its
  `prelude` and `snapshot`, which the read delivers separately.

### Breaking: `state` on `router.push()`, `router.replace()`, and `<Link>` is typed, so a bare entry or an uncalled definition no longer compiles ([#997](https://github.com/rangojs/rango/pull/997))

`state` was typed `LocationStateEntry[] | unknown`, which TypeScript reduces
to `unknown`, so any value compiled. It is now `HistoryState`:
`readonly LocationStateEntry[] | PlainHistoryState`, where
`PlainHistoryState` is structured-clone-safe plain data (primitives, arrays,
`Map`/`Set`, `ArrayBuffer`, typed arrays, plain objects) that is not a
function, symbol, `Promise`, `WeakMap`, or `WeakSet`, and carries no
`__rsc_ls_*` fields. `<Link state>` takes the same type, or a click-time
getter for it. `HistoryState` and `PlainHistoryState` are exported from
`@rangojs/router/client`.

Three mistakes that compiled and then failed at runtime are now compile
errors:

```tsx
router.push(url, { state: GridState({ count: 3 }) }); // entry without the array
router.push(url, { state: [GridState] }); // definition, not called
router.push(url, { state: [GridState({ count: 3 }), { from: "list" }] }); // mixed
```

The first spread the entry's `__rsc_ls_key`/`__rsc_ls_value` fields onto
`history.state`, so `useLocationState(GridState)` read `undefined`; the second
threw `DataCloneError`; in the third only the first element picked the format,
so the rest were lost. In development all three also throw an error that names
the definition's key or the offending index, for JavaScript callers;
production builds drop the check.

Migration:

- Put typed entries in an array of entries only, and call the definition:
  `{ state: [GridState({ count: 3 })] }`.
- A state value typed `unknown` no longer compiles. Narrow it, or type it as
  `PlainHistoryState`.
- A function as `state` on `router.push()`/`router.replace()` no longer
  compiles. It reached `history.pushState` and threw `DataCloneError`; call it
  yourself (`{ state: getState() }`). A getter on `<Link state>` still works.
- `LinkState` is now `StateOrGetter<HistoryState>` (it was
  `LocationStateEntry[] | StateOrGetter<Record<string, unknown>>`), so it also
  accepts interface-typed objects, primitives, arrays, and readonly entry
  arrays.
- Plain state is checked at the top level only (array, `Map`, and `Set`
  elements included). A function, symbol, or React element inside a plain
  object, or a top-level React element or DOM node, still compiles and still
  throws `DataCloneError`. A typed `createLocationState<T>()` definition checks
  `T` all the way down.

### Breaking: location state in unit tests needs a key, and `renderRoute` pushes clear it like production ([#997](https://github.com/rangojs/rango/pull/997))

Two changes fail unit tests that passed on 0.18.0.

A `createLocationState()` definition without its plugin-injected key now
throws outside production, in tests as well as in development. Under
`NODE_ENV=test` the key read returned `undefined`, so `Def(value)`,
`useLocationState(Def)`, and `.read()`/`.write()` used
`history.state["undefined"]` with no error. The Vite plugin that injects keys
does not run in a unit-test project, so a test that renders a component
reading a definition it did not seed now fails, and a server-side test whose
code calls `Flash(value)` (`redirect(url, { state: [Flash(value)] })`,
`ctx.setLocationState(Flash(value))`) captures the missing-key error on
`thrown` instead of the redirect. The react-server test project runs with
`NODE_ENV=production`, so there an unkeyed value lands on
`locationState["undefined"]`. Production builds keep no check: the plugin
always sets the key there
([#993](https://github.com/rangojs/rango/issues/993)).

`renderRoute` (`@rangojs/router/testing/dom`) now writes the history entry of a
`useRouter().push()`/`replace()` or a `<Link>` click the way production does.
A push or `<Link>` without `state` starts an entry with no location state, so
`useLocationState()` reads `undefined` afterwards. Before, the harness left
`history.state` untouched and a seeded value survived the navigation.
`router.navigate()` from the test still leaves `history.state` alone.

Migration:

- Key each definition a test reads without a seed, once per test file:
  `withLocationStateKey(Flash, "Flash")` from `@rangojs/router/testing`
  (below). A definition passed to `renderRoute`'s `locationState` seed is keyed
  for you. Assert server-side `locationState` under the prefixed key:
  `{ __rsc_ls_Flash: value }`, or `{ [Flash.__rsc_ls_key]: value }`.
- A test that expects location state to survive a `push()` or `<Link>` click
  passes the state on that navigation:
  `router.push(url, { state: [Def(value)] })`.

### Added: `withLocationStateKey()` keys a location-state definition in a unit test ([#997](https://github.com/rangojs/rango/pull/997))

`withLocationStateKey(def, name?)` from `@rangojs/router/testing` assigns the
key the Vite plugin would inject: `withLocationStateKey(GridState,
"GridState")` sets `__rsc_ls_GridState`; without a name it keeps an existing
key or assigns a synthetic one that stays the same for that definition.
`renderRoute`'s `locationState` seed keys a definition the same way.

`renderRoute` (`@rangojs/router/testing/dom`) now applies the `state` of a
`useRouter().push()`/`replace()` or a `<Link state>` click, so a component
reading `useLocationState(Def)` sees the value it pushed with `[Def(value)]`.
Before, the harness dropped `state`.

### Fixes

- A deferred handle push from an `ssr: false` loader with its own `cache()`
  now reaches a PPR shell HIT. When the loader's `cache()` entry missed at
  capture, the shell recorded only its settled pushes and asked for the
  loader to run on a HIT; when that entry then hit, the shell's restore had
  already claimed the loader, so the entry's replay was skipped and the
  deferred push was missing from the HIT's hydration payload while the
  prelude showed it. The replay now runs: its settled values give way to the
  shell's, and its deferred ones are added
  ([#998](https://github.com/rangojs/rango/pull/998)).
- A PPR shell HIT or partial navigation replay no longer adds its
  per-request overlay store to the handler's registry of explicit
  `cache({ store })` stores. Each one added an entry, so every
  `updateTag()`/`revalidateTag()` called the app store's `invalidateTags()`
  once more per HIT served, and past the registry's cap of 64 the oldest
  entries, a `cache({ store })` store among them, were pushed out and an
  invalidation stopped reaching them until they were resolved again
  ([#998](https://github.com/rangojs/rango/pull/998)).
- A document the document cache stores no longer hands the first visitor's
  theme to `useTheme()` for everyone else. The stored document carried
  `initialTheme` from the theme cookie of the visitor who rendered it, so a
  visitor with no stored theme kept that visitor's `useTheme().theme` for the
  life of the page; the `<html>` class was right, since the theme script reads
  the cookie. A page whose response opts in to the document cache before
  `next()` (an `s-maxage` `Cache-Control` from the handler, or from
  middleware before `await next()`) now carries the no-cookie default
  (`defaultTheme`), as a `ppr` shell capture does, and a visitor with a stored
  theme gets it after hydration. Any other render, a 404 included, keeps the
  visitor's theme. A `Cache-Control` set after `await next()` or in
  `onResponse` arrives after the page is rendered: such a response is stored
  only when it was rendered with the default theme, so set `Cache-Control` in
  the handler or before `next()`
  ([#987](https://github.com/rangojs/rango/pull/987)).
- A PPR capture whose in-place retry ran out of its route `cache()` record
  now ends as a terminal no-shell: the key backs off and the route warns once.
  Before, a cold first attempt followed by an `expired` retry left the key
  without backoff, so every later request started a capture again
  ([#988](https://github.com/rangojs/rango/pull/988)).
- A PPR capture that waited in the isolate's capture queue is no longer
  treated as stranded while it runs inside its 25 s hard cap. The stampede
  guard counted the cap from scheduling, so a capture read as abandoned once
  its queue wait plus its run time passed 25 s, while it was still inside
  its own cap, and the next request for the same URL scheduled a duplicate
  capture beside it. The guard's age now counts from the task's start, so
  the queue wait and the SSR module load are not held against it, and from
  the cap's start once the capped run begins
  ([#988](https://github.com/rangojs/rango/pull/988)).
- A navigation-only PPR capture no longer makes a document MISS skip its own
  capture. A corrupt-snapshot heal stores a navigation-only entry under the
  document key, which document serving reads as a MISS; counting it as a
  stored shell made a document MISS that read the store just before skip its
  capture (`skip-stored`), for one extra MISS
  ([#988](https://github.com/rangojs/rango/pull/988)).
- A `ppr` client navigation served from stored segments (a shell replay,
  `x-rango-ppr-replay: HIT`, or the route's own `cache()`,
  `BYPASS; reason=explicit-cache-hit`) no longer re-sends a segment with
  `transition({ when })` that the navigation does not re-send on the live path
  (`BYPASS; reason=no-entry`): a segment whose `revalidate()` returns false, or
  a layout the default keeps, including the `transition(config, () => [...])`
  wrapper. The stored copy replaced the segment the client held, so a list the
  client had built up ("Load more" appending a page, then navigating to
  `?page=N`) showed only the captured page, while the live path kept it. Such a
  segment is now omitted from the response, whatever the predicate returns,
  and the client keeps its copy. The predicate still gates the transition of
  every segment the response sends. A kept layout's `when` result, which the
  replay used to deliver with the re-sent layout, no longer applies, the same
  as on the live path: the client holds by the `transition` its copy carries
  ([#989](https://github.com/rangojs/rango/issues/989)) (#986,
  [#990](https://github.com/rangojs/rango/pull/990)).
- The compile error for a `createLocationState<T>()` value that cannot be
  structured-cloned names the failing field and the reason. It reported one
  message for the whole type, so an `unknown` field three levels down took a
  hand-written type probe to find. The `LocationStateUnsafe` brand now carries
  the path, one per failing field:
  ``LocationStateUnsafe<"`unknown` cannot be verified as serializable; give it a concrete type", "items[].info.values">``
  (`.` for fields, `[string]`/`[number]` for index signatures, `[]` for array
  and `Set` elements, `[0]` for tuple elements, `<key>`/`<value>` for `Map`,
  `<root>` for the value itself). An object's own unsafe fields are reported
  before anything nested deeper, so a DOM node or class instance stops at its
  methods, and the walk stops 8 levels deep. Which types are accepted is
  unchanged
  ([#993](https://github.com/rangojs/rango/issues/993))
  ([#997](https://github.com/rangojs/rango/pull/997)).

- Work that started before `updateTag()`/`revalidateTag()` of one of its
  tags, in another request, no longer stores its value when it finishes
  (#977). Every built-in store stamps an entry when it is written
  (`CFCacheStore`'s `taggedAt`, `VercelCacheStore`'s `ta`) or checks
  nothing (`MemorySegmentCacheStore`), so a `"use cache"` call that read its
  data before another request's `updateTag("stock")` and finished after it
  was served as newer than the invalidation until it expired; 0.18.0 closed
  this only for the invalidating request. Now each writer checks, before its
  store write, whether one of the entry's tags was invalidated after its
  execution started, and skips the write if so: `"use cache"` misses and
  stale refreshes, a loader's own `cache()` misses and refreshes, route
  `cache()` records and response-route entries, and the document cache. The
  check reads this isolate's invalidations from every request, and the
  store's markers for another isolate's: KV markers on `CFCacheStore`, `tm`
  markers on `VercelCacheStore`. A loader's own `cache()` checks from the
  earliest run its value came from, so a value a parent layout's handler
  started computing before the invalidation is not stored either. A skipped
  write costs the next read a miss, never a stale read; the execution still
  returns what it read. A `"use cache"` call also no longer joins an
  in-flight execution that started before another request's, or another
  isolate's, invalidation of its tags. The document cache checks from the
  start of the request, since a middleware ahead of it can read what the
  document bakes. Writes of one request that check at the same time share
  a marker read in flight. A marker the check cannot read (an error, a KV
  timeout) counts as an invalidation there, so the write is skipped.
  Not covered: another isolate's invalidation within the execution's first
  millisecond; a KV-less `CFCacheStore` (another isolate's invalidation
  leaves no marker to read; ttl+swr bounds it); a KV marker another colo
  wrote that this colo's KV read does not return yet; with `tagCacheTtl`,
  this colo's cached marker, up to `tagCacheTtl` behind another colo; and
  an invalidation that lands between the marker read and the store write.
  An entry whose tag is invalidated more often than its execution takes
  never fills, since each write started before the latest invalidation;
  nested tags (above) make that likelier. Two routers in one isolate that
  share a tag name skip each other's writes started before an invalidation
  (a miss). A custom store takes part through `isTagsInvalidatedSince()`;
  without it, only this isolate's invalidations are checked
  ([#996](https://github.com/rangojs/rango/pull/996)).

## 0.18.0 (2026-09-30)

### Breaking: a nested `cache()` keys its records within the enclosing `cache()`'s `key()` partition ([#983](https://github.com/rangojs/rango/pull/983))

A `cache()` nested in a keyed `cache()` ignored the outer `key()`: the
innermost boundary alone decided the record key (#970). An inner `cache()`
without `key` stored under the default key, and an inner `key()` dropped the
outer one, so a visitor in one partition received what a visitor in another
partition had cached under the inner boundary. With PPR, the shell partition
follows the record key, so the shell was shared the same way.

A `key()` now partitions every record under its `cache()`. The record key is
a list of parts, outermost first, each URI-encoded and joined by `|`:

- An inner `cache()` without `key`: the enclosing `key()` results, then its
  own default key (its store's `keyGenerator` result when the store has one,
  else the default key). Its routes keep their own records, as before, and
  gain the partition.
- An inner `cache()` with its own `key`: the enclosing `key()` results, then
  its own (`tier%3Agold|v%3Aa`). Two partitions never share an inner record,
  and the inner key still splits within a partition.
- Deeper nesting composes the same way.
- Unchanged: a single keyed `cache()` keeps its raw `key()` result, a
  `cache()` with no `key` anywhere above it keeps its default key, and
  `cache(false)` caches nothing.
- A response route's entry is keyed the same way. A `ppr` route's shell and
  its client navigation replay are partitioned by the `key()` results (the
  shell key already carries the URL). Each `key()` still runs once per
  request.

```tsx
cache({ ttl: 300, key: (ctx) => `tier:${tierOf(ctx)}` }, () => [
  layout(TierLayout, () => [
    cache({ ttl: 60 }, () => [
      path("/pricing", PricingPage),
      path("/faq", FaqPage),
    ]),
  ]),
]);
// Before: the /pricing record was keyed "doc:<host>/pricing" for every tier;
// a silver visitor could HIT the record a gold visitor's request wrote.
// After: it is keyed "tier%3Agold|doc%3A<host>%2Fpricing" (or silver's);
// each tier renders its own, and /faq keeps its own record.
```

The breaking parts:

- Records under a nested `cache()` in a keyed one move to new keys, so they
  miss once after deploy.
- A prerendered `ppr` route under a `cache()` without `key`, nested in a
  keyed one, was unpartitioned and served its build-time shell. It is now
  partitioned by the outer `key()`, so it stops serving the build shell:
  each partition captures its own at runtime, and the once-per-route
  build-shell warning fires.

Migration: to share an inner cache across partitions on purpose, move it
outside the keyed `cache()`; to keep serving a route's build shell, move the
route out from under the keyed `cache()`. In tests, `shellCacheKey(url, searchParams,
partition)` takes the nested `key()` results as an array, outermost first,
and composes them the way the router does. Composed keys never collide with
each other, but a single `key()` result is stored as returned: don't return
raw request input from `key()` (prefix, normalize or encode it), or a value
containing `|` can name another partition's record
([#975](https://github.com/rangojs/rango/issues/975)).

### Breaking: reading the visitor's theme on a `ppr` or `cache()` route refuses the capture or throws, like `cookies()` ([#979](https://github.com/rangojs/rango/pull/979))

`ctx.theme` in a handler, `ctx.theme` in middleware and
`getRequestContext().theme` are the visitor's theme cookie, but they were
plain reads. A `ppr` shell, a route `cache()` entry or a `"use cache"` entry
stored the first visitor's theme and served it to every later visitor until
the entry expired (#971). The shell also stored the capturing visitor's theme
as its `initialTheme`, so on a HIT a visitor with no stored theme kept that
visitor's `useTheme().theme` for the life of the page.

The reads are now guarded like `cookies()`, with the same exemptions:

- On a `ppr` route, a handler that reads the theme has its shell capture
  refused (warned once per URL). Every request stays an
  `x-rango-shell: MISS` rendered with that visitor's theme.
- Inside a `cache()` boundary or a `"use cache"` function the read throws. A
  `cache()` route that reads it answers 500 where it used to answer 200.
- The shell's `initialTheme` is the no-cookie default (`defaultTheme`),
  whoever captured it. A visitor with a stored theme gets it pre-paint from
  the theme script and in `useTheme()` after hydration.
- The theme getters are read-only and non-enumerable. `{ ...ctx }` and
  `Object.assign({}, ctx)` no longer carry `theme`, and `ctx.theme = x` throws
  (it is typed `readonly`). Read `ctx.theme` directly.
- A fetchable loader's ctx is a spread of the request context, so an untyped
  JS fetchable loader no longer sees `ctx.theme` at runtime (`LoaderContext`
  never typed it). Read `getRequestContext().theme` or the cookie instead.
- `ctx.theme` is read when it is accessed, so after `ctx.setTheme()` in the
  same request it returns the new theme, as the middleware ctx already did.

Read the theme where it is per request: `useTheme()` in a client component,
or a live loader (no `ssr: false`).

```tsx
// Before: the first visitor's theme was stored in the shell and served to all.
path("/settings", (ctx) => <SettingsPage theme={ctx.theme} />, { ppr: true });

// After: the page reads the theme on the client.
path("/settings", () => <SettingsPage />, { ppr: true });
```

```tsx
// settings-page.tsx
"use client";
import { useTheme } from "@rangojs/router/theme";

export function SettingsPage() {
  const { theme } = useTheme();
  return <p>{`theme: ${theme}`}</p>;
}
```

A server-side read moves into a live loader, read under `loading()`:
`createLoader(async () => cookies().get("theme")?.value ?? "system")` (the
cookie name is `storageKey`).

### Breaking: a loader's own `cache()` fails the fill and stores nothing when its body reads `cookies()`/`headers()` without a `key()` ([#982](https://github.com/rangojs/rango/pull/982))

A loader bound with its own `cache()` (`loader(Loader, () => [cache({...})])`)
stores its value under loader, host, path and params. Nothing in that key
names the user, and an enclosing route `cache()` key does not partition it.
A body that read `cookies()` stored the first visitor's session in the entry
and served it to every later visitor for the TTL, with nothing thrown or
logged (#972).

On a miss, the loader now fails, and nothing is stored, when its execution
read `cookies()`, `headers()` or a non-cacheable variable
(`createVar({ cache: false })`, or a value written with
`ctx.set(..., { cache: false })`), unless the binding declares identity: a
`key()` on the loader's `cache()`, or a `keyGenerator` on its store. The check
tests only that one of them is there, so it must itself include the value. The
loader fails the same way whoever ran the body: the binding, or a reader that
started the loader first (a parent layout's handler calling `ctx.use()`). It
also fails when the body reads another loader with `ctx.use()` that read them,
including a keyed cached loader served from its own cache: that entry keeps
the read its miss made. A stale entry's background refresh fails the same way
(reported to `onError`; the stale entry keeps serving). A read that settles
after the value, in a promise inside it or in a handle push that settles
within the 5 s handle-encode timeout, can't fail what was already served: that
user gets their own value, nothing is stored, and `onError` gets the error. A
push still pending after the timeout drops the entry's handles; the value is
stored without them. A cookie write alone (`cookies().set()`) is not a read. A theme read
(`getRequestContext().theme`, or a handler or middleware `ctx.theme` read
inside a loader body) counts like a `cookies()` read. A loader without
its own `cache()` is unchanged, under a route `cache()` too.

```ts
const SessionLoader = createLoader(async () => ({
  session: cookies().get("session")?.value,
}));

// Before: user B received user A's { session: "a" } until the TTL ran out.
// After: the miss fails —
//   cookies() cannot be called inside loader "…#SessionLoader", whose own
//   cache() has no key(). …
loader(SessionLoader, () => [cache({ ttl: 60 })]);
```

Migration: add a `key()` that includes what the body reads, or drop the
loader's `cache()` if the value must stay per request.

```ts
loader(SessionLoader, () => [
  cache({
    ttl: 60,
    key: () => `session:${cookies().get("session")?.value ?? "anon"}`,
  }),
]);
```

Entries stored before the upgrade are not checked: a HIT skips the body. In a
store that versions its keys per deploy (`CFCacheStore`'s build version) they
are gone after the deploy. In one that doesn't (`VercelCacheStore` without
`options.version`, a pinned `version`, a shared external store), a leaked entry
keeps serving through its TTL and SWR window, because a failed refresh keeps
the stale entry. The same store also keeps keyed entries written before the
upgrade without the identity mark, so an unkeyed cached loader that reads one
on a HIT or stale hit fills without error, until that keyed entry is rewritten
(its refresh stores the mark), and serves that value through its own TTL and
SWR window. On such a store, when an unkeyed cached loader reads a keyed one,
bump the store's `version` or `updateTag()` the affected tags after the
upgrade.

### Breaking: a route `cache()` entry is tagged by what its content recorded, so `updateTag()` evicts shells and documents built from it ([#965](https://github.com/rangojs/rango/pull/965))

On a `ppr` route with its own `cache()`, the shell capture replays the route's
`cache()` entry instead of rendering again, so no covered handler or server
component runs. The entry carried only its `cache({ tags })`, so the shell
was stored without the tags those components recorded with `cacheTag()` or a
`"use cache"` read. `updateTag()` of such a tag then left the page on
`x-rango-shell: HIT` until the shell's ttl+swr, even after the awaited call
resolved (#957). A document-cache entry stored while the `cache()` entry was a
HIT lost the same tags.

A route `cache()` entry now stores the tags its content recorded when it was
written: render-callable `cacheTag()` calls and `"use cache"` reads, in the
handlers, server components and handle values it covers, `loading()` subtrees
included (a HIT replays their output too). A loader's tags reach the entry only when a
handler consumes its value with `ctx.use()`, whoever started the loader; a
loader nobody reads on the server (a `useLoader()` under `loading()`) runs
per request and stays off. The entry records its tags again on every HIT, so
the shell or document built from the HIT carries them.

The breaking part is that those tags also invalidate the `cache()` entry.
Before, only `cache({ tags })` did, and after `updateTag()` the entry kept
replaying the output rendered before the mutation until it expired.

```tsx
function CampaignLayout() {
  cacheTag("campaign"); // render-callable: no "use cache" around it
  return <Banner />;
}
layout(CampaignLayout, () => [
  cache({ ttl: 600 }, () => [path("/sale", SalePage, { ppr: true })]),
]);

await updateTag("campaign");
// Before: the /sale shell captured from the cache() entry stayed a HIT, and
// the entry kept the old banner, until ttl+swr.
// After: shell and entry are dropped; the next request renders fresh.
```

Migration: none is needed for correctness. Suppose a tag inside a cached
subtree is meant for the document only, and it changes often enough that
re-rendering the entry costs too much. On a route without `ppr`, move the
`cacheTag()` to a layout above the `cache()`: that layout re-runs on every
HIT and stays out of the entry.

`CFCacheStore.set()` now resolves once its Cache API write lands. Before, it
resolved as soon as the write was scheduled. The PPR capture waits for the
page render's `cache()` write before reading it, so it replays the entry
instead of rendering the page a second time. In the production run of
`tests/cloudflare-basic` `ppr-tag-eviction` (10 repeats, 60 captures), captures
that re-rendered went from 30 to 0.

### Breaking: a PPR shell HIT never runs a route handler; everything a handler produces is baked into the shell ([#969](https://github.com/rangojs/rango/pull/969))

A `ppr` route's shell HIT used to re-run the route's handlers in several
cases: a handler that awaited a loader (`ctx.use(Loader)`), a handle push with
a promise nested in its value, a `transition({ when })` predicate the
pre-handler gate had not evaluated, a route `cache()`
whose own tier missed or used `key()`, a store `keyGenerator`, a build-time
shell, and a capture whose segment record did not settle in time. The re-run
cost the handlers' work on every HIT, and its output replaced the captured
output in the page payload, so the payload could disagree with the HTML the
shell had frozen. A handler promise passed to a component under `<Suspense>`,
or an async server component, was a hole only when it lost the capture's
timing race, so whether it streamed per request or froze depended on how fast
it was.

The capture now waits for everything a handler produces, within
`ppr.captureTimeout`, stores it as the shell's segment record, and renders the
shell from that record. Every HIT replays the record; only middleware and
loaders run (not a promise-free `ssr: false` loader, below). A value you want
fresh per request belongs in a live loader.

```tsx
layout(async (ctx) => {
  const reviews = fetchReviews(ctx.params.id); // not awaited
  return (
    <Suspense fallback={<Spinner />}>
      <Reviews data={reviews} />
    </Suspense>
  );
});
// Before: when fetchReviews was slower than the capture's quiet window, the
// shell froze the spinner and every HIT fetched and streamed the reviews.
// After: the capture waits for fetchReviews; the reviews are in the shell and
// every HIT serves them until the shell expires or its tags are invalidated.
```

Migration: everything a handler produces is shell material, as it is under
`cache()`: a promise it passes to a component under `<Suspense>`, an async
server component, a nested promise in a handle it pushes, and a loader it
awaits are all awaited at capture (bounded by `ppr.captureTimeout`) and served
frozen for the shell's lifetime. A HIT never runs a handler. To keep a value
fresh per request, load it in a loader without `ssr: false` and read it with
`useLoader` under `loading()` or an inline `<Suspense>`; inside an
`ssr: false` loader, return that part as a nested promise. Request-scoped
reads the capture now waits for refuse it: `cookies()`, `headers()`, a
`{ cache: false }` variable, and `ctx.dynamic()` inside a handler promise, an
async component, a handle push, or a loader a handler awaits. A normal
`ctx.get()` value is not guarded: shell material is shared per host, URL and
request partition, so a variable your middleware sets per visitor (a tenant,
a locale, a user) and a handler reads is captured once and served to every
visitor of that URL in that partition. Declare such a variable with
`createVar({ cache: false })` to make the capture refuse instead, or
partition the route by it (below). `cache(false)`, or a `condition()` that returns false, on a
`ppr` route now renders the request like a cache miss (no shell, no
`x-rango-shell` header, no capture); before, the document still served shell
HITs and only the handlers the HIT re-ran saw the opt-out.

Shells are partitioned by the same request keys that partition the route's
`cache()` record: the route's `cache({ key })`, or the store's
`keyGenerator`. Each partition captures, serves and replays its own shell;
a visitor is never served another partition's. A route with neither keeps
one shell per host, path and filtered search.

```tsx
cache(
  { ttl: 300, key: (ctx) => `tier:${ctx.request.headers.get("x-tier")}` },
  () => [path("/pricing", PricingPage, { ppr: true })],
);
// Before: one /pricing shell; a HIT replayed whichever tier captured it.
// After: /pricing has a shell per tier; gold and silver each capture their own.
```

A route's `key()` runs once per request: the shell read, the record lookup
(document or client navigation) and the capture share its result, so a
`key()` that reads `cookies()` works on a `ppr` route (the capture used to
run it again and its guard refused the capture). A store `keyGenerator` runs
once per default key it is given; one that returns the default key unchanged
partitions nothing. A `key()` or `keyGenerator` that throws serves no shell
for that request, like the record path renders uncached. A build-time shell
is never served for a partitioned route: the build captured one partition.

Keep partition values to a small, known set (normalize a header or cookie to
the tiers or locales you serve before returning it): every distinct value
captures and stores a shell of its own. Query strings multiply shells the same
way, since the shell key includes the sorted search: a product page reached as
`?color=red&size=m` and `?color=blue&size=m` has two shells, and an appended
tracking param mints another. `createRouter({ cache: { searchParams } })`
drops params from the key, shell included (for example
`{ exclude: TRACKING_SEARCH_PARAMS }`); exclude only a param the shell does
not render from.

A unit test pins both through `serveShellRequest`
(`@rangojs/router/testing/flight`): count a handler's runs across a MISS and
the HITs after it (they stay put while a loader under `loading()` runs on
every HIT), and serve each partition with its own request headers; the
result's `key` is the key production resolved, partition included.

Also changed:

- `@rangojs/router/testing`: `shellCacheKey(url, searchParams, partition)`
  takes the request partition (what the route's `key()` or the store's
  `keyGenerator` returns) for a partitioned route, and appends it
  URI-encoded, as the serve path does.
- `@rangojs/router/testing/flight`: `serveShellRequest`'s `key`, and so
  `readEntry()`, is the shell key the serve path resolved for the document,
  request partition included.
- `@rangojs/router/cache`: the `ShellCacheEntry` fields `handlerLiveHoles`
  and `transitionWhen` are removed. No HIT runs a handler, so no entry marks
  itself as needing one; a custom store that set or read them can drop them.
- `@rangojs/router/testing`: the `PprReplayBypassReason` values
  `"handler-live-holes"` and `"transition-when"` are removed; a partial
  navigation no longer reports them.
- A HIT whose segment record cannot be read has already sent the shell and
  cannot render the rest without running handlers. It ends the response with
  a script that reloads the page once with a `_rsc_shell=miss` query marker;
  a request carrying the marker renders like a cache miss (no shell, no
  capture), so the reload cannot repeat. The router drops the marker from the
  request before anything reads it, so middleware, handlers, loaders, cache
  keys and `useSearchParams` see the URL the visitor asked for, and the
  browser drops it from the address bar before the page hydrates. When the entry is broken (a record
  that fails to decode, a snapshot that lacks it or does not parse) the HIT
  also replaces the entry and schedules a recapture; when a `CFCacheStore`
  snapshot read was only slow (over max(`kvReadTimeoutMs`, 1 s) on the
  document read) the entry stays. Before, the HIT re-ran the handlers.
- A shell never outlives the route `cache()` entry it was captured from: it
  stays fresh no longer than that entry does and is served no longer than
  that entry can be (its ttl, and its ttl + swr, are capped to what the entry
  has left, in whole seconds). An entry already in its `swr` window gives a
  shell that is stale from the start, served while it recaptures; each
  isolate recaptures a stale shell at most once per second. A capture that
  outlives the entry it read retries once with a fresh render. No shell is
  stored when that retry's entry runs out too, when the capture budget
  leaves no time to retry, or when the capture wrote the entry itself and it
  ran out before the store; the URL then backs off, and a warning with the
  entry's `ttl` and `swr` is logged once per route. Before, a
  document request could replay the capture's handler output for the whole
  shell ttl after the route's `cache()` entry had expired or refreshed, while
  a client navigation of the same URL read the newer entry. In dev, an
  explicit `ppr.ttl`/`ppr.swr` that the entry reduces warns once per route and
  states what the shell is stored with. A custom store's `putShell` receives
  a capped window in whole seconds; its ttl is 0 for a shell that is stale
  from the start.
- `CFCacheStore` with KV writes every PPR shell to KV. A shell whose lifetime
  is under KV's 60-second `expirationTtl` minimum is written with that
  minimum, and its reads still expire it at its own deadline. Before, such a
  shell (a `ppr` ttl + swr under 60 s, or one capped by a short route
  `cache()`) stayed in the Cache API of the colo that captured it.
- A request whose route is partitioned (`cache({ key })` or a store
  `keyGenerator`) does not serve the route's build-time shell; when the route
  has one, a once-per-route warning says so. A `keyGenerator` that returns the
  default key unchanged partitions nothing and keeps it.
- A capture that runs out of `ppr.captureTimeout` is not retried in place: its
  handlers may still be running. The no-shell warning names the cause.
- `ppr.maxSnapshotBytes` bounds only the loader data the snapshot pins; the
  segment record is always kept. A capture whose whole entry, measured as the
  store writes it (prelude, snapshot, and a head carrying the postponed state
  and tags), exceeds the store's value limit is refused with a warning:
  25 MiB by default (Cloudflare KV), three quarters of `maxItemBytes` on
  `VercelCacheStore`.
- A capture that produced no segment record is refused instead of stored.
- `ppr.captureTimeout` also bounds the capture's match, at runtime and at
  build time: handlers, and the loaders they await, that have not returned by
  the deadline store no shell (the warning names them). Before, the deadline
  started after the match.
- A shell's tags are its segment record's (what the handlers, the server
  components they render and the loaders they consume recorded, #965), its
  bake-lane loaders' and `ppr.tags`, so a capture that renders the page and
  one that replays the route's `cache()` record store the same set. A tag
  recorded on the request outside what the shell renders no longer tags it.
- `debugShellCapture` events carry `recordSettleMs` (`record=`) and
  `entryBytes` (`entry=`); `snapshotBytes` counts the loader pins only.
- `ShellCaptureDebugEvent["outcome"]` gains `"expired"`: an attempt whose
  route `cache()` entry ran out before it could store the shell (retried
  once in place), and `"skip-stored"`: a document MISS skipped its capture
  because another request's capture stored the shell while the MISS
  rendered. Before, that MISS captured the page again, and the new store
  dropped the isolate's memo of the shell stored a moment earlier, so the
  next HIT read the store instead. A `switch` over the outcome that checks
  exhaustiveness needs cases for both.

Measured with `vite preview` against the previous commit: test-app
`/shell-cache` captured in 288 ms instead of 1,182 ms and reached its first HIT
in 2.3 s instead of 3.6 s (its segment record used to miss the capture's 1 s
write window, so the entry stored none and every HIT re-ran the handlers);
`/shell-cache/baked-only` reached its first HIT in 0.5 s instead of 2.5 s. On
`tests/cloudflare-basic` the stored `/ppr-large` entry is the same 1,647,731
bytes and its HIT's first byte on the #941 edge-latency harness is unchanged
(8.3-8.5 ms untagged, 9.4-9.6 ms tagged).

### Breaking: on a `ppr` route, a loader a handler awaits cannot read `cookies()` or `headers()` ([#969](https://github.com/rangojs/rango/pull/969))

A small, intended limit that follows from the change above. Handler output is
baked by design, and a loader a handler awaits (`await ctx.use(Loader)`) is
part of it: it runs at capture, and every HIT serves the captured value. It
used to be exempt from the capture guard because the handler re-ran on every
HIT; with no handler on a HIT, an identity read there would show the capturing
user to every visitor, so the capture now refuses it. Awaiting a loader from a
handler is not the common path (components read loaders with `useLoader`),
and `cache()` is unchanged: on a route without `ppr`, such a loader may still
read `cookies()` and `headers()`.

Symptom: the route answers `x-rango-shell: MISS` on every request, and the
server logs, once per key:

```
[rango] Shell capture for "<key>" was refused: the loader "<loader id>" called cookies() during capture; request-scoped data must not bake into the shared shell. Read it in a loader without ssr: false and consume it with useLoader under loading() or an inline <Suspense> (a live hole). …
```

Fix: register the loader on the route with `loading()` (the live lane, run on
every request) and read it with `useLoader` in a client component instead of
awaiting it in the handler:

```tsx
path("/account", AccountPage, { name: "account", ppr: true }, () => [
  loader(UserLoader), // reads cookies(); live, fresh on every HIT
  loading(<AccountSkeleton />),
]);
```

When the value has a small, known set of values (a tier, a locale),
partitioning the route with `cache({ key })` also works: `key()` may read
`cookies()` or `headers()` and selects which shell a visitor gets. The loader
itself still must not call them; hand it the value through a variable your
middleware sets.

### Breaking: a promise-free `ssr: false` loader does not run on a PPR shell HIT ([#969](https://github.com/rangojs/rango/pull/969))

A HIT is rendered from the shell, so live values are meaningless there, the
same reason no handler runs. A bake-lane (`ssr: false`) loader whose return
held no promises used to run on every HIT anyway, in the background, and its
result was discarded. Now it does not run: the container pinned at capture is
served.

A client navigation that replays the shell (`x-rango-ppr-replay: HIT`) now
matches the document HIT. Before, it ran every loader and served its fresh
values. Now a promise-free `ssr: false` loader is served from its pin without
running, and one whose return holds promises runs with its baked parts pinned
over the fresh result, including an `ssr: false` loader on an entry that also
has `loading()`.

```tsx
path("/product/:id", ProductPage, { name: "product", ppr: true }, () => [
  loader(ProductLoader, { ssr: false }), // returns { name, description }
]);
// Before: ProductLoader's body ran on every HIT; its result was discarded.
// After: it runs at capture only; every HIT serves the captured container.
```

Side effects in such a loader's body (logging, counters, writes) now happen
once per capture instead of once per request; move per-request work into
middleware or a live loader. Its own `cache()` is read at capture only, so a
recapture reads through it. A loader whose return holds promises is unchanged:
it runs on every HIT, because only its body can create the live promises, and
its baked parts are overlaid on the fresh result.

The settled handle pushes of the loaders a bake-lane loader awaits with
`ctx.use()`, and those a loader's own `cache()` entry replays at capture, are
now recorded with the shell too, so they still appear, once, on a HIT that
runs neither. A push the capture cannot record (a deferred push, or one
holding a promise) keeps those loaders running on each HIT, in the
background, as before.

### Breaking: a loader's own `cache()` entry is tagged by what its body recorded, so `updateTag()` drops it ([#968](https://github.com/rangojs/rango/pull/968))

A loader bound with its own `cache()` (`loader(Loader, () => [cache({...})])`)
stored only its `cache({ tags })`. On a HIT its body does not run, so the tags
the body recorded were lost for that request: `cacheTag()` calls, and the tags
of `"use cache"` reads inside it. `updateTag()` of such a tag left the loader
serving its old value until ttl+swr. A route `cache()` record, PPR shell or
document written over the HIT lacked the tag too, so the fix above (#965)
could not evict them either.

The entry now stores the tags its body recorded when it was written: its
`cacheTag()` calls, its `"use cache"` reads, render-time tags of server
components in its value or handle pushes, and the tags the loaders it reads
with `ctx.use()` record, including a loader the route or a layout also binds,
or the handler read first. A loader it reads that has its own `cache()` also
brings its `cache({ tags })` and, on a HIT, its stored tags. Every HIT records
them again, so a record, shell or document built over the HIT carries them, and
so does a loader that reads this one. A stale HIT's background refresh stores
the refreshed body's tags, not the stale entry's, and runs the loaders it reads
again rather than reusing the page's stale copies.

The breaking part is that those tags now invalidate the loader's entry.
Before, only `cache({ tags })` did.

```tsx
export const ProductLoader = createLoader(async (ctx) => {
  cacheTag(`product-${ctx.params.id}`);
  return db.product(ctx.params.id);
});
loader(ProductLoader, () => [cache({ ttl: 600 })]);

await updateTag("product-42");
// Before: /product/42 kept the old product until the entry's ttl.
// After: the entry is dropped; the next request runs the loader.
```

Migration: none is needed for correctness. If a tag the body records is meant
for the page only, and dropping the loader's entry with it costs too much, call
`cacheTag()` in the handler that reads the loader instead of in the loader
body. An entry written before this release carries only its `cache({ tags })`
until it expires or is rewritten. One rare case keeps a loader's
`cache({ tags })` off a reader's entry: a cached loader reads another loader
before that loader's own `cache()` binding starts (a cached layout loader
reading a route's cached loader) and writes its entry first. It still stores
the tags that loader's body records; add `cacheTag()` for the config tags in
that loader's body if the reader must drop with them.

### Added: `runLoader()` runs a loader through its own `cache()` ([#968](https://github.com/rangojs/rango/pull/968))

`runLoader()` and `runLoaderResult()` take a `cache` option: the options a
route binds the loader with (`loader(Loader, () => [cache({...})])`). The call
goes through the production loader-cache read-through against `cache.store` or
`cacheStore`, so a HIT returns the stored value without running the body, and
`updateTag()` of a tag the body recorded drops the entry. Use it in the
react-server project (real Flight); the write is a background task the call
does not await.

```ts
const load = () =>
  runLoader(ProductLoader, {
    params: { id: "42" },
    cacheStore,
    cache: { ttl: 600 },
  });
await load(); // MISS: the body runs
await load(); // HIT, once the write landed: the body does not run
await runInRequestContext(() => updateTag("product-42"), { cacheStore });
await load(); // MISS again
```

### Breaking: a PPR hole reads the current `"use cache"` entry, not the shell's captured copy ([#958](https://github.com/rangojs/rango/pull/958))

When a `ppr` route's shell and one of its live holes (a loader under
`loading()` or an inline `<Suspense>`) read the same `"use cache"` entry,
a shell HIT used to hand the hole the copy frozen in the shell's capture
snapshot, so the hole matched the shell until the shell expired. The hole now
reads the entry from the cache store. It is still cached under its own
profile (ttl, swr, tags) and does not re-execute on every request; once the
entry expires or is invalidated and refreshes, the hole shows the refreshed
value while the shell keeps the value it was captured with. Nothing changes
for an entry a loader also read during the capture (an `ssr: false` loader,
or a loader a handler awaits): the hole keeps the captured value for it too.

```tsx
async function getStock(sku: string) {
  "use cache: short"; // ttl 60
  return fetchStock(sku);
}
// The layout (shell) and the loader under loading() (hole) both read it.
// Before: after the entry refreshed, the hole still showed the captured stock.
// After: the hole shows the refreshed stock; the shell keeps the captured one.
```

Migration: if the hole must show the shell's value, pass it down from the
shell (a prop, or a handle the hole reads) instead of reading the entry again
in the live loader.

### A PPR shell entry stores only what a HIT reads ([#958](https://github.com/rangojs/rango/pull/958))

A shell entry's capture snapshot held every cache read the capture made. When
every HIT replays the handlers' output from the captured segment record, the
`"use cache"` items the handlers read to produce it are never read again; the
capture no longer stores them. A navigation-only entry (captured for partial
navigations) stores only its segment records. On `tests/cloudflare-basic`
`/ppr-large` the stored entry went from 3,272,863 to 1,647,811 bytes (snapshot
2,643,864 to 1,018,799), which a HIT reads and parses after its first byte. In
dev the same snapshot was 16,960,162 bytes, over the 8 MiB `maxSnapshotBytes`
cap, so it was not stored at all; it now is (1,374,662 bytes). Under
`debugPerformance` the `shell tail` line and `ppr-tail` row show what was
dropped next to what was kept (`records=segment:1 pruned=item:5`).

### Added: a tag-marker memo for PPR shell reads, and a fresh-reads cookie after `updateTag()`/`revalidateTag()` ([#960](https://github.com/rangojs/rango/pull/960))

A tagged PPR shell HIT waited for its tag-invalidation markers before its
first byte: on `CFCacheStore` a KV read that started once the entry's head
named the tags, on `VercelCacheStore` a runtime-cache read after the entry
read. Both stores now remember which tags each shell carried (and take a
route's `ppr.tags` as known up front), start those marker reads alongside the
entry read, and keep marker values per isolate, stale-while-revalidate: a
value younger than `memo.markerFreshMs` (default 1000 on `CFCacheStore`, 300
on `VercelCacheStore`) is used as is, one younger than `memo.markerMaxStaleMs`
(default 10000 and 2000) is used while a background read refreshes it, and an
older one waits for the store read. `{ markerFreshMs: 0 }` turns the value
memo off. With the #941 edge latencies injected, a tagged shell's first byte
on `CFCacheStore` is 0.1 ms instead of 10.5 ms on a shell memo hit and 8.3 ms
instead of 17.5 ms on a store read; on `VercelCacheStore`, with a 6 ms
runtime-cache read modeled, 0.1 ms instead of 7.0 ms and 10.8 ms instead of
18.5 ms. Only PPR shell reads use the value memo: `cache()`, `"use cache"`
and response entries, and the shell write gate, keep reading their markers.

A mutation still gets correct reads. The request that runs `updateTag()` or
`revalidateTag()` reads its own writes, the isolate that runs it writes the
new marker into its memo, and its response sets the fresh-reads cookie:
`<state cookie prefix>-fresh` (`rango-state-fresh` by default, one per prefix,
so every router on the host that shares the prefix honors it), `HttpOnly`,
`SameSite=Lax`, `Path=/`, `Secure` on https, with a `Max-Age` of the longest
time the stores' memos can be stale plus 1 s (11 s for `CFCacheStore` with
KV, 3 s for `VercelCacheStore` and for `CFCacheStore` without KV). The same
user's requests that carry it skip both memos on every isolate. That closes,
for the mutating user, the two cases the shell memo left open:
`CFCacheStore` without KV in purge mode, and `VercelCacheStore` in another
region. Other users can get a shell whose memoized marker predates an
invalidation for up to `markerMaxStaleMs`, on top of the platform's own
consistency (KV propagates across locations in up to about 60 s); set
`{ shellMs: 0, markerFreshMs: 0 }` where every user's next request must see an invalidation.
A store with both memos off (for example `MemorySegmentCacheStore` alone)
sets no cookie. The cookie is lost when `updateTag()`/`revalidateTag()` runs
after the response headers were sent (from a streaming loader or render; dev
warns). Any client can send the cookie; it only makes that client's own
requests read the store, the cost of memos off.

A response whose request called `updateTag()` or `revalidateTag()` now
carries that `Set-Cookie` when an invalidated store keeps memos, which keeps
it out of the document cache, a response route's `cache()`, and CDNs that
do not cache responses with cookies (Cloudflare's among them). Under `debugPerformance`
the `ppr:shell-marker` row adds `memo=fresh|stale|read|bypass`,
`hint=<hinted>/<tags>`, `lead=` (how long the hinted marker reads ran before
the entry named its tags), and `fresh-reads` when the cookie was present.

### Added: a per-isolate PPR shell memo in `CFCacheStore` and `VercelCacheStore` ([#959](https://github.com/rangojs/rango/pull/959))

A warm isolate serving the same PPR shell repeatedly re-read and re-parsed the
stored entry on every HIT. Both stores now keep the last fresh read of each
shell for `memo.shellMs` (default 2000; `{ shellMs: 0 }` turns it off) under a
`memo.shellMaxBytes` cap (default 16 MiB, least recently used evicted), and
serve the next HITs from memory. On a storefront-sized shell a `CFCacheStore`
memo hit's first byte is 0.2 ms instead of 8.3 ms (untagged) and 10.2 ms
instead of 17.3 ms (tagged) with Cloudflare's measured I/O latencies injected;
a `VercelCacheStore` memo hit is 0.1 ms instead of 10.8 ms and 6.9 ms instead
of 17.9 ms with a 6 ms runtime-cache read modeled. Under `debugPerformance`
both stores report the read as `ppr:shell-read (hit memo)` with a
`ppr:shell-memo` row (hit or miss, and the memo's size), and a
`VercelCacheStore` HIT now reports its store read and tag-marker read too.
`VercelCacheReadOutcome`, the outcome the `VercelCacheStore` `debug` option
receives, gains `"memo-hit"`.

The tag-marker check still runs on every HIT, and the isolate that runs
`updateTag()`/`revalidateTag()` drops its own memoized copies, so neither that
request nor a later one on the same isolate gets the invalidated shell. With
KV bound, a `CFCacheStore` memo in any isolate rejects it once that isolate's
marker read sees the invalidation (see the tag-marker memo above). What
another isolate can still serve for up to one window: the previous
capture of a key another isolate just recaptured; for `CFCacheStore` without
KV in purge mode, a purged shell (the purge reaches the stored entry, not
other isolates' memos), the mutating user's next request included when it
lands on another isolate; for `VercelCacheStore`, a shell invalidated from
another region (the tag markers are a regional `cache.set`; without the memo,
`expireTag` removed the entry everywhere within about 300 ms) or by a platform
`expireTag` issued outside rango. The fresh-reads cookie (above) sends the
mutating user's next requests past the memo; an app where every user's next
request must see the invalidation sets `{ shellMs: 0, markerFreshMs: 0 }` (with
KV, `CFCacheStore`'s marker memo serves other users an invalidated shell for
up to `markerMaxStaleMs` even with the shell memo off).
`VercelCacheStore` keeps one memo per `cache` handle: create the
`getCache()` handle once per process, as the updated examples do, or the
memo never hits.

### Added: a PPR shell HIT broken into `debugPerformance` rows ([#955](https://github.com/rangojs/rango/pull/955))

Under `debugPerformance`, a PPR shell HIT reported one `ppr:shell-read` row.
With `CFCacheStore`, that read is now broken into `ppr:shell-match`,
`ppr:shell-head` and `ppr:shell-prelude` (with byte counts),
`ppr:shell-marker` (the tag-marker read and how long the commit waited on it),
and, for a KV hit after a Cache API miss, a `ppr:shell-l1-miss` row first.
Every store then shows `ppr:shell-open` (the integrity check and decode) and
`ppr:shell-commit` (chunk count and prelude bytes), both labelled `cpu`. The
work after the commit (snapshot read and parse, seed, tail) prints as one
`[RSC Perf] … shell tail:` line with snapshot bytes, records per family, and
CPU durations, and rides the next request's `Server-Timing` as `ppr-tail`, now
in production too when the HIT collected metrics. In production, nothing is
collected when `debugPerformance` is off.

### Added: `serveShellRequest()`, a real PPR shell capture and HIT in unit tests ([#966](https://github.com/rangojs/rango/pull/966))

No `@rangojs/router/testing` primitive ran a `ppr` route's shell capture or
served a shell HIT, so what a HIT shows, when a shell recaptures, and what
`updateTag()` evicts could only be tested in e2e (#956).
`serveShellRequest(router, url, options?)` from
`@rangojs/router/testing/flight` serves one GET through the router's
production request handler, with its `nonce`, `version`, `cache` config and
middleware, and settles the request's background tasks before it resolves. The
first request for a `ppr` route is a MISS whose capture has stored the shell;
the next one with the same store is a HIT from it. `partial` serves a client
navigation and reports its `x-rango-ppr-replay` decision:

```tsx
const cacheStore = new MemorySegmentCacheStore();
const miss = await serveShellRequest(router, "/product/1", { cacheStore });
// miss.shellStatus === "MISS"; await miss.readEntry() is the stored shell
const hit = await serveShellRequest(router, "/product/1", { cacheStore });
// hit.shellStatus === "HIT"
// hit.prelude: the shell as captured; hit.flight: this request's tail
```

Only the HTML step is stubbed, because `react-dom/server` does not load under
the react-server condition: the prelude is the Flight text the capture
rendered, and a HIT body is that prelude followed by the tail's Flight. Real
prelude HTML, its `<body>` sanity gate, SSR render errors, the capture
deadline's partial prelude, and fizz resume of the holes stay e2e.

`resetShellTestState()`, from the same entry, clears the PPR state a worker
keeps across requests and a test file keeps across tests: the capture's
backoff and stampede guard, and `CFCacheStore`'s isolate memos. Call it in
`beforeEach`.

### Fixes

- The request that calls `revalidateTag()` reads its own writes. A server
  action that called `revalidateTag("x")` and then rendered got the
  pre-invalidation value of `"use cache"` and `cache()` entries tagged `x`:
  on `CFCacheStore` with KV until the KV marker write landed, and for the
  rest of the request once a read had memoized the absent marker; on
  `VercelCacheStore` until `expireTag` landed; on `MemorySegmentCacheStore`
  when the read started in the same tick, as a `"use cache"` call right after
  `revalidateTag()` does. `revalidateTag()` now calls each store's
  `invalidateTags()` before it returns, and each built-in store marks the
  tags as invalidated for the rest of that request before its first await;
  only the durable write (KV marker, tag purge, `expireTag`) stays in the
  background. Other requests see the invalidation when that write lands, as
  before. The mark only turns that request's hits into misses: if the
  durable write fails, the request pays extra misses, not a stale read. This
  also changes the failed-write case of `await updateTag()` on `CFCacheStore`
  and `VercelCacheStore`: the call still rejects, and the rest of the request
  now misses on the tags instead of reading the entries.
  `VercelCacheStore` stamps tagged entries with their write time, so an entry
  the request writes after its invalidation still hits (one written in the
  same millisecond misses); entries written before this release count as
  older. A custom `SegmentCacheStore` gets the same behavior by recording the
  invalidation in request-scoped state before the first `await` of its
  `invalidateTags()`. More same-request cases are fixed, for both verbs. A
  `"use cache"` call made earlier in the request, whose store write was
  still pending, was reused by the same call after the invalidation
  (`await getStock("beer"); revalidateTag("stock"); await getStock("beer")`
  returned `"beer #1"` twice), and with `await updateTag()` its write landed
  after the invalidation and was read back. A stale entry's background
  refresh that started before the call wrote its pre-invalidation value
  after it, for the rest of the request and for later requests. Now an
  execution or refresh that started before one of its own tags was
  invalidated is neither joined nor written, and concurrent calls after the
  invalidation share one fresh execution. An execution with other tags, or
  one that starts after the call in the same millisecond, still fills the
  store. The mask also reaches contexts derived from the request (a PPR HIT
  tail after an invalidation in middleware). On a `CFCacheStore` in purge
  mode without KV, an L1 entry without the store's entry Cache-Tags (written
  before they existed) was served after the request's own invalidation; it
  now misses. Not covered, as before this release
  ([#977](https://github.com/rangojs/rango/issues/977)): a `"use cache"`
  execution in another request, or a loader's own `cache()` in any request,
  that started before the invalidation can still write its value after it,
  on every built-in store, and later reads can get that value
  ([#981](https://github.com/rangojs/rango/pull/981)).
- In dev, a PPR route whose `ssr: false` loader returns JSX now captures its
  shell and HITs. Before, Flight logged
  `Attempted to render <…> without development properties`, the capture
  failed with `TypeError: Cannot read properties of undefined (reading 'stack')`,
  and every request stayed `x-rango-shell: MISS`. The same applies to JSX in a
  handle value pushed during a capture. A promise in the props of a host
  element, `<Suspense>` or a client component (`<p>{fetchStock()}</p>`) is a
  live hole and the rest of that JSX stays baked on every HIT. A server
  component with a promise in its props
  (`reviews: <Reviews data={fetchReviews()} />`) is a live hole as a whole: on
  a HIT it renders from the fresh loader run. Before, in production too, the
  shell stored that server component's output rendered with a placeholder in
  place of the promise, and every HIT served it
  ([#967](https://github.com/rangojs/rango/pull/967)).
- A PPR shell capture no longer stalls when an `ssr: false` loader value
  reaches the same promise-holding object twice
  (`{ summary: shared, card: { shared } }`). The snapshot encode waited
  forever on the capture's never-settling stand-in for that promise, so the
  shell was never stored
  ([#967](https://github.com/rangojs/rango/pull/967)).
- A loader body that reads a loader bound with its own `cache()`
  (`await ctx.use(ProductLoader)`) gets the binding's value, as a handler read
  does. On a loader-cache HIT the read used to run the bound loader's body
  again, so the reader saw a different value from the one the page rendered,
  and the body ran twice in one request
  ([#968](https://github.com/rangojs/rango/pull/968)).
- A `CFCacheStore` PPR shell read whose memoized shell went stale keeps the
  route's `ppr.tags` in its tag-marker prefetch. When the isolate's tag-name
  hints had evicted the key, the store read started those marker reads only
  after it parsed the entry's head ([#963](https://github.com/rangojs/rango/pull/963)).
- A PPR shell HIT whose capture snapshot is already in memory
  (`MemorySegmentCacheStore`, build-time shells, the new shell memo) no longer
  starts the resumed tail's work before the prelude is written: the tail waits
  one macrotask after the commit when the snapshot had already arrived (one
  still arriving on I/O yields on its own). With the shell memo on local
  workerd, a storefront-sized HIT's first byte over a trivial response went
  from 5.9 ms to 1.3 ms ([#959](https://github.com/rangojs/rango/pull/959)).
- A PPR shell capture no longer renders the page's server components twice.
  It rendered them once for the stored segment record and again for the page
  payload the shell's HTML was frozen from, so uncached nondeterministic
  server output (an async server component reading a counter or the clock)
  could differ between the shell's HTML and the payload every HIT replays,
  and hydration repaired the mismatch on every HIT. The capture now renders
  the shell from the stored record.
- A PPR shell HIT whose captured segment record fails to decode now schedules
  a recapture. The HIT reports `cache-corrupt` and degrades as described under
  "a PPR shell HIT never runs a route handler" above; before, nothing replaced
  the entry, so every HIT re-rendered the handlers until the shell expired
  ([#958](https://github.com/rangojs/rango/pull/958)).
- A PPR shell capture no longer gives up while a client component in the
  shell is still loading its module. The capture aborted a fixed number of
  task turns after the page payload arrived, and a client component outside
  any Suspense boundary could still be loading then, so the attempt stored
  nothing and retried 400 ms later: about 400 ms more per `Prerender` + `ppr`
  URL that loaded a client module first (with `DEBUG=rango:prerender`,
  `vite build` logs `shell capture attempt 1/2 for <url> produced no shell`). On
  `tests/cloudflare-basic`, `/ppr-shell/prerendered/alpha` went from 495-501 ms
  to 112-119 ms, `/ppr-shell/passthrough/baked` from 447-452 ms to 38-39 ms, and
  the shell phase from 1329-1366 ms to 552-584 ms. A runtime capture in a cold
  isolate had the same race. Once its payload settles, the capture now waits,
  within `ppr.captureTimeout`, for the client module loads in flight in the
  isolate, including loads another render requested; live loaders
  and promises passed down from the server still postpone as holes
  ([#954](https://github.com/rangojs/rango/pull/954)).
- A `vite build` that rewrote a router's `named-routes.gen.ts` (the first
  build after adding, renaming or removing a route, or any build that found
  the file out of date) could skip every build-time PPR shell. The build-time
  server that runs route discovery and the shell phase watched the project,
  so the rewrite could reload its modules (when the router file's importers
  end at an entry nothing imports, as in a Cloudflare `worker.rsc.tsx`) and
  drop the route trie discovery had installed; the shell phase then matched
  each `Prerender` + `ppr` URL in declaration order. A wildcard such as
  `path("/*")` declared before the route won, every candidate logged
  `SHELL SKIP <url> - no router matched "<route>" (matched: <wildcard route>, ...)`,
  and the routes fell back to capturing the shell on the first request after
  deploy. The next build, with the file up to date, captured them. That
  server no longer watches files
  ([#951](https://github.com/rangojs/rango/pull/951)).
- A PPR shell HIT decodes its stored prelude once instead of twice, with the
  runtime's native `Uint8Array.fromBase64` where it exists (workerd: 0.05 ms
  instead of 0.75 ms per decode of a 614 KB prelude), and enqueues it in 32 KB
  chunks instead of one write. A streaming compressor handed one write
  compresses all of it before its first output byte; with 32 KB chunks, Node's
  zlib and workerd's `CompressionStream` emit their first bytes after one
  chunk (measured locally; Cloudflare's edge compressor was not measured).
  Partial navigation replay no longer decodes the document prelude it never
  serves. The no-shell warning names an async server component rendered
  without awaiting its data as a cause, and in dev it prints the component
  stacks still pending when the capture froze the shell
  ([#952](https://github.com/rangojs/rango/pull/952)).
- `CFCacheStore` stores a PPR shell prelude-first: a head, the raw prelude
  (no base64), then the capture snapshot, in both the Cache API and KV. A
  shell HIT reads the head and the prelude, runs the tag-marker read alongside
  the prelude read, and sends its first byte while the snapshot is still being
  read; only the resumed tail waits for it. On a storefront-sized shell (614 KB
  prelude, 2.5 MB snapshot) the first byte moved from 13.2 ms to 3.6 ms over a
  trivial response on local workerd, and from 21.0 ms to 8.3 ms (29.8 ms to
  17.5 ms when tagged) with Cloudflare's measured I/O latencies injected. The
  public `getShell`/`putShell` contract is unchanged. Shells move to a new key
  namespace; existing entries are already misses after a deploy (buildVersion)
  and age out. One failure mode changes: a truncated, corrupt, or slow
  snapshot used to make the read a MISS; on the document read (slow meaning
  over max(`kvReadTimeoutMs`, 1 s)) it is now a HIT whose resumed tail cannot
  replay the segment record, so the page reloads once into a cache-miss
  render (see "a PPR shell HIT never runs a route handler" above), and a
  truncated or corrupt entry is also evicted, replaced and recaptured.
  `getShell` (partial navigations, the testing helpers) keeps
  `kvReadTimeoutMs` and misses
  ([#953](https://github.com/rangojs/rango/pull/953)).

## 0.17.0 (2026-09-28)

### The default document restores scroll on back/forward ([#948](https://github.com/rangojs/rango/pull/948))

An app that passes no `document` to `createRouter` now gets
`<Html.ScrollRestoration />` from the router's default document, next to the
`Html.Meta` and `Html.Scripts` it already rendered. Back and forward return to
the scroll position each page was left at, saved per history entry in
`sessionStorage`, and the router sets `history.scrollRestoration = "manual"`.
New navigations still scroll to the top or the hash target.

To keep the browser's own back/forward scrolling, or to pass `getKey`, provide
your own `document`. With the default document, a second
`<Html.ScrollRestoration />` in a layout only logs
`[Scroll] Already initialized`.

### Back/forward scroll is left to the browser when it owns restoration ([#923](https://github.com/rangojs/rango/pull/923))

With a custom `document` that doesn't render `<Html.ScrollRestoration>`, the
browser restores back/forward scroll itself, but the router also called
`scrollTo(0, 0)` after every `popstate`. When the browser restored first, the
router's call won and back landed at the top of the page (reported in mobile
Safari). The router no longer scrolls on back/forward for an entry whose
`history.scrollRestoration` is `"auto"`. That also covers entries created
before `<Html.ScrollRestoration>` mounted. A bfcache restore no longer switches
`scrollRestoration` to `"manual"` in apps that never mounted
`<Html.ScrollRestoration>`, so the browser keeps restoring there too.

### Breaking: the document components move under `Html` ([#937](https://github.com/rangojs/rango/pull/937))

`MetaTags`, `Scripts` and `ScrollRestoration` are replaced by one namespace
exported from `@rangojs/router/client`: `Html.Meta`, `Html.Scripts` and
`Html.ScrollRestoration`, with the same props. The old component exports are
removed, with no aliases.

```tsx
// before
import { MetaTags, Scripts, ScrollRestoration } from "@rangojs/router/client";
<head><MetaTags /><Scripts /></head>
<body><Scripts position="body" />{children}<ScrollRestoration /></body>

// after
import { Html } from "@rangojs/router/client";
<head><Html.Meta /><Html.Scripts /></head>
<body><Html.Scripts position="body" />{children}<Html.ScrollRestoration /></body>
```

A server root layout can render `<Html.Meta />` as well as a client document,
and an app that never renders `<Html.ScrollRestoration />` does not bundle it.
The script renderer's dev warnings are now prefixed `[Html.Scripts]`.
`useScrollRestoration`, `ScrollRestorationProps`, the `Meta`, `Script` and
`Breadcrumbs` handles, and `ThemeScript` are unchanged.

### Back/forward keeps an entry's location state and scroll position ([#943](https://github.com/rangojs/rango/pull/943))

Going back to an entry the router's history cache no longer holds (it keeps 20
entries; also after a deploy or a cross-tab cache clear) refetches the page.
That refetch used to replace the entry's `history.state`, so
`useLocationState()` returned `undefined` for an entry that had state, and with
`<Html.ScrollRestoration>` the entry's saved scroll position was lost. It also saved
the page being left under the returning entry's key. The entry's history state
is now kept as the browser restored it, with any server-set state merged in.

With `<Html.ScrollRestoration>`, back and forward now also save the scroll position
of the page being left, so forward to a page you scrolled and then left with
back returns to where you were instead of the top.

### Breaking: `intercept()` `use()` rejects items an intercept never applies ([#872](https://github.com/rangojs/rango/pull/872), [#879](https://github.com/rangojs/rango/pull/879))

An intercept's `use()`, and the `.use` of a handler mounted with
`intercept()`, now throw at definition time for `revalidate()`,
`errorBoundary()`, `notFoundBoundary()`, `cache()`, `parallel()`,
`intercept()`, `include()`, and a `layout()` with `use()` items of its own. A
rejected helper that is called but not returned throws too. The error names
the intercept and says where the item goes. `middleware()`, `loader()` (which
keeps its own `revalidate()` and `cache()`), `loading()`, `transition()`, route
items, and a `layout()` used as modal chrome stay valid.

In 0.16.0 these items were dropped or misplaced without an error:

- `revalidate()`, `errorBoundary()` and `notFoundBoundary()` were stored on
  the intercept and never read, from the explicit `use()` and from the
  handler's `.use` alike.
- A nested `layout()`'s own `use()` items were dropped.
- `parallel()` and `intercept()` in an explicit `use()` registered on the
  enclosing layout.

`InterceptUseItem` no longer includes `revalidate()`, `errorBoundary()` or
`notFoundBoundary()`, so a typed explicit `use()` fails to compile with them.
A handler's `.use` is typed for every mount site, so there the check is
runtime only: a handler mounted with both `path()` and `intercept()` whose
`.use` returns `errorBoundary()` still works on the `path()` mount, but route
registration (`router.routes()`) now throws at startup.

Migration: put boundaries on the layout or path that declares the intercept
(its boundaries handle the intercept's handler and loader errors, see #878
below), `revalidate()` on the intercept's loader, and `cache()` on the target
route. For a handler shared between `path()` and `intercept()`, move the
boundaries out of its `.use` into the `path()` call's own `use()`.

```tsx
// before: throws at definition time
intercept("@modal", "product", <ProductModal />, () => [
  loader(ProductLoader),
  errorBoundary(<ModalError />),
]),
// after
layout(<ShopLayout />, () => [
  errorBoundary(<ShopError />),
  intercept("@modal", "product", <ProductModal />, () => [
    loader(ProductLoader),
  ]),
]),
```

### Breaking: `ctx.reverse` in middleware and response routes is typed global-only ([#873](https://github.com/rangojs/rango/pull/873))

`MiddlewareContext["reverse"]` and `ResponseHandlerContext["reverse"]` are now
the new exported `GlobalReverseFunction`. Both are built from the route map
alone at runtime, with no `include()` scope and no param auto-fill, so a
dot-local `ctx.reverse(".name")` always threw `Unknown route` on the request;
it is now a compile error. Response routes also lose a permissive fallback:
when no route in the generated map had a `search` schema, 0.16.0 typed their
reverse as `(name: string, ...)`, so an unknown name, a name held in a
`string`, or a call missing required params compiled. With a generated map
these are now checked against it, as middleware reverse already was. Without
a generated map, any name except a dot-prefixed literal is accepted. Runtime
behavior is unchanged. Pass the fully qualified name and every param.

### Breaking: a component that throws while a route is prerendered fails the build ([#917](https://github.com/rangojs/rango/pull/917))

A `Prerender()` route or `Static()` handler could return normally while its
tree held a component that threw during the build-time render, such as an
async server component whose fetch failed. Flight encoded that component as an
error row, the build logged `OK`, and the route served its error boundary
until the next build. The error now takes the same path as a handler throw:

- `prerender.onError: "fail"` (the default) fails the build and names the URL
  and the error.
- `"warn"` logs `WARN` and skips the URL.
- A `Skip` thrown by the component skips the URL.
- The router's `onError` receives it with phase `"prerender"` or `"static"`.

Intercept variants and handle values are checked the same way. In dev, the
`/__rsc_prerender` endpoint falls through to a live render for such a route
instead of serving a payload that holds the error row.

Migration: a build that passed with such a route now fails. Fix the component,
`throw new Skip()` for URLs that cannot render at build time, or set
`rango({ prerender: { onError: "warn" } })` to skip them.

### Breaking: a `middleware()` wrapper with no routes inside rejects `layout()` ([#922](https://github.com/rangojs/rango/pull/922))

`middleware(fn, () => [layout(...)])` with no route inside the callback now
throws when `router.routes()` runs, in a path's children and in a layout's
children alike. In 0.16.0 the nested `layout()` never rendered, while the
middleware ran for every route of the enclosing path or layout: a wrapper with
no routes scopes nothing. The error points to the flat form, which renders the
layout and runs the middleware for the same routes. A wrapper with routes
inside may still hold a `layout()`, and a routeless wrapper without one
(`middleware(fn, () => [loader(L)])`) is unchanged.

```tsx
// before: AccountNav never rendered; now throws at definition time
path("/account", AccountPage, { name: "account" }, () => [
  middleware(requireAuth, () => [layout(<AccountNav />)]),
]),
// after
path("/account", AccountPage, { name: "account" }, () => [
  middleware(requireAuth),
  layout(<AccountNav />),
]),
```

### Breaking: a `"use cache"` function that reads a `{ cache: false }` variable throws ([#935](https://github.com/rangojs/rango/pull/935))

`ctx.get()` of a `createVar({ cache: false })` variable, or of a value written
with `ctx.set(key, value, { cache: false })`, now throws inside a `"use cache"`
function, as it already did inside a `cache()` boundary. It throws whether the
read goes through `getRequestContext().get()`, a handler ctx or a response-route
ctx passed in. In 0.16.0 the read returned the value, the result was stored
under a key that did not include it, and later callers were served the first
caller's value until the entry expired. Ordinary variables stay readable. A
loader body the cached function consumes with `await ctx.use(Loader)` stays
exempt, as under `cache()`; a `"use cache"` function called from a loader does
not.

Migration: read the value before calling the cached function and pass it in as
an argument, so it becomes part of the cache key.

```ts
const Tenant = createVar<string>({ cache: false });

// before: the first tenant's nav was served to every tenant; now throws
async function getNav() {
  "use cache";
  return loadNav(getRequestContext().get(Tenant));
}
// after
async function getNav(tenant: string) {
  "use cache";
  return loadNav(tenant);
}
const nav = await getNav(ctx.get(Tenant)!);
```

### Breaking: `"use cache"` runs a call uncached when an argument cannot be serialized ([#934](https://github.com/rangojs/rango/pull/934))

A `"use cache"` function that took a `Request` served the first caller's
result to every later caller. The key encoder writes the same placeholder,
`"$T"`, for any value it cannot serialize, so
`getPage(new Request("https://a.example/"), "/")` and
`getPage(new Request("https://b.example/"), "/")` shared one entry. Functions,
class instances and symbols, top-level or nested, collided the same way. Now:

- A `Request` (such as `ctx.request`) keys by its URL: host, pathname and the
  user-facing search params, normalized as for `ctx`. Headers and cookies are
  not in the key.
- The request's `env` is left out of the key.
- React elements (`header`/`children` slots) and client or server references
  stay out of the key and the call stays cached, as before.
- Any other argument that cannot be serialized runs the call uncached and
  warns once per function in dev.

A call that passed a binding such as `env.DB`, a callback or a class instance
was cached in 0.16.0 and now runs every time. Pass `env`, or the serializable
values the function needs:

```ts
// before: keyed by id alone, whichever db was passed; now runs uncached
async function getProduct(db: D1Database, id: string) {
  "use cache";
  return db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
}
// after
async function getProduct(env: Env, id: string) {
  "use cache";
  return env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
}
```

### Breaking: a loader or middleware `ctx` passed to `"use cache"` is keyed and guarded like a handler `ctx` ([#946](https://github.com/rangojs/rango/pull/946))

A fetchable loader called with a request body shared one `"use cache"` entry
across every body. Its ctx is marked request-scoped, so a `"use cache"`
function taking it was keyed by route, params and search, never the body: in
0.16.0 two users' `load({ method: "POST", body })` calls with different bodies
got the first caller's result. A ctx carrying a `body` or form data now runs
the call uncached and warns in dev.

The loader ctx (`getProduct(ctx)` inside a loader) and the middleware ctx were
not marked request-scoped. In 0.16.0 a `"use cache"` call taking one was keyed
by the ctx's plain fields as the Flight encoder serialized them: the full URL
including internal `_rsc*` parameters (so a document load and a client
navigation of the same page used separate entries), pathname, params and the
env's plain values, but not the route name. Its `ctx.use(Handle)` pushes were
not recorded, so they were missing on every hit, and nothing guarded
`{ cache: false }` reads or middleware writes. They now behave like a handler
ctx:

- The ctx is left out of the key and its route fields are folded in: host,
  route name, pathname, params and search (a loader ctx also carries the
  response type). A loader ctx keys exactly like the handler ctx of the same
  request. A middleware ctx has a route name only once the route is matched.
- A loader ctx's `ctx.use(Handle)` pushes are captured on a miss and replayed
  on a hit into the loader's segment, once per request, as for a handler ctx.
- `ctx.get()` of a `{ cache: false }` variable through either ctx throws
  inside the function. A loader body the function consumes with
  `await ctx.use(Loader)` stays exempt.
- A middleware ctx's `set()`, `header()` and `ctx.headers` writes throw inside
  the function; their effect would be lost on a hit.

Request headers and cookies are not in the key, as with a handler ctx: a
function that reads them through `ctx.request` gets one entry per route. Read
those values outside and pass them in.

```ts
async function getProduct(ctx: { params: { id: string } }) {
  "use cache";
  ctx.use(Breadcrumbs)({ label: "Product" });
  return db.product(ctx.params.id);
}
export const ProductLoader = createLoader(async (ctx) => getProduct(ctx));
// before (0.16.0): keyed by the raw URL, so a navigation missed the entry the
// document load wrote, and the crumb was missing on every hit
// after: one entry per route, id and query; the crumb is replayed on a hit
```

### Added: `router.debugManifest()` on the public `Rango` type ([#874](https://github.com/rangojs/rango/pull/874))

`debugManifest()` was typed only on the internal router interface, so calling
it needed a cast. It is now on `Rango`, and its return type
`SerializedManifest` is exported from `@rangojs/router`. It also threw
`Duplicate route name` for any router that uses `include()`, because lazy
include placeholders carried the parent `urls()` handler and re-registered its
routes. Placeholders are now skipped, so routes mounted with `include()` are
absent from the result.

### Added: per-navigation loader seeds and held navigations in `renderRoute()` ([#893](https://github.com/rangojs/rango/pull/893))

`renderRoute().navigate()` from `@rangojs/router/testing/dom` committed
urgently and took no per-navigation data, so the 0.16.0 `useLoader().isLoading`
stale state could only be tested in e2e. `navigate(url, { loaders })` now takes
loader seeds for that navigation, merged over the render-time seeds, and a spec
with `transition` (`{}` mirrors a bare `transition()`) commits the navigation
through production's transition path. A reader held on screen then reports
`isLoading: true` on the old data while a pending Promise seed is unsettled,
and `false` with the new data in the commit that settles it:

```tsx
const { router } = await renderRoute(
  [{ path: "/products/:id", Component: ProductPrice, transition: {} }],
  { request: "/products/1", loaders: [[ProductLoader, { price: 10 }]] },
);
await router.navigate("/products/2", { loaders: [[ProductLoader, next]] });
// ProductPrice: isLoading true with price 10 until `next` settles
```

Without `transition`, the commit stays urgent and a pending read suspends to
its `<Suspense>` fallback. `useNavigation().state`, `useLinkStatus().pending`
and `useAction().state` stay `idle`, and production's same-structure hold
without `transition()` is not modeled.

### Fixes

- An intercept handler that throws or calls `notFound()` no longer fails the
  soft navigation with a 500 that bypasses every boundary. The modal slot
  renders the `errorBoundary()` / `notFoundBoundary()` of the layout or path
  that declares the intercept (or the nearest ancestor with one), with a
  500 / 404 status, as intercept loader errors already did. A thrown
  `Response` (`redirect()`) still short-circuits; an async handler under
  `loading()` still streams its rejection and is now reported to `onError`
  ([#878](https://github.com/rangojs/rango/pull/878)).
- A loader with its own `cache()` (`loader(Def, () => [cache()])`) skips its
  body on a hit, so the body's `ctx.use(Handle)` pushes (Meta title,
  breadcrumbs) were missing on every hit. The miss now records the pushes of
  the body and of loaders it awaits through `ctx.use`, and every hit, stale
  included, appends them to the owning segment. A stale revalidation's fresh
  pushes go only into the refreshed entry
  ([#877](https://github.com/rangojs/rango/pull/877)).
- A route under `cache()` recorded every handle push of its segments,
  including pushes from DSL `loader()` bodies. On a hit the record was
  replayed and the loader re-ran and pushed again, so a handle without
  key-based dedupe showed the value twice. DSL-loader pushes are now left out
  of the `cache()` record; handler pushes and pushes from a handler's
  `ctx.use(Loader)` are still recorded
  ([#880](https://github.com/rangojs/rango/pull/880)).
- A `"use cache"` hit replaced the calling segment's handle arrays, wiping the
  handler's earlier pushes and concurrent loader pushes, and the miss recorded
  every push made while the body ran. Each execution now records only its own
  pushes (nested cached functions roll up into the caller), and a hit appends
  them. A layout and a page calling the same cached function each keep their
  copy, and a stale hit's background refresh no longer leaks its pushes into
  the live response ([#882](https://github.com/rangojs/rango/pull/882)).
- The stale-route refresh and proactive caching swapped the request's handle
  store for a fresh one while they re-rendered in the background. The
  foreground was still producing the page (a stale hit re-runs its loaders;
  proactive caching starts while the body streams), so handle pushes made in
  that window went into the background render and were missing from the page.
  Both now render on a derived request context with its own store.
  `RequestContext._handleStore`, an `@internal` field typed through
  `getRequestContext()` from `@rangojs/router/rsc`, is now `readonly`
  ([#883](https://github.com/rangojs/rango/pull/883)).
- Intercept loaders honour the loader's own `cache()`:
  `intercept(..., () => [loader(Def, () => [cache()])])` re-ran the loader on
  every intercept navigation. A handler's `ctx.use(Loader)` stays a live read
  memoized per request; `cache()` belongs to the DSL `loader()` binding
  ([#884](https://github.com/rangojs/rango/pull/884)).
- Build-time PPR shell capture passed global and route middleware a
  `ctx.reverse` scoped to the previewed route (`include()` scope, param
  auto-fill), while live requests pass the global-only map reverse, so a
  `.name` call resolved at build and threw `Unknown route` live. Build capture
  now uses the same global-only reverse
  ([#876](https://github.com/rangojs/rango/pull/876)).
- PPR capture warnings (bake cost, no usable shell, identity refusal, rejected
  or redirecting loader) and the `cookies()`/`headers()` capture error still
  advised `loading()` or nested promises. They now state the lane rule: only
  `loader(Def, { ssr: false })` executes at capture, and every other loader is
  live and needs `loading()` or an inline `<Suspense>` above its reader
  ([#871](https://github.com/rangojs/rango/pull/871)).
- `import type { LoaderOptions } from "@rangojs/router"` failed for installed
  consumers: the root `types` condition resolves to the `react-server` entry,
  which did not export it ([#870](https://github.com/rangojs/rango/pull/870)).
- A layout above a `cache()` boundary was stored in the route's cache entry and
  replayed on every hit: it ran 0 times, its output was the miss render's, and
  a header it wrote was missing from every hit. The entry now holds only the
  boundary's subtree, and a hit renders the segments above the boundary on
  every request, document and partial alike, as the `cache()` docs describe.
  A `ppr` route keeps whole-chain coverage: its chain bakes into the shell
  ([#911](https://github.com/rangojs/rango/pull/911)).
- A `cache()` among a path's children, as in
  `path("/p", Page, { name: "p" }, () => [cache({ ttl: 60 }), layout(<Chrome />)])`,
  cached nothing, and a `layout()` declared after it never rendered. It now
  caches that path: the handler and the path's own layouts and parallels are
  stored and replayed, and everything above the path stays live. The same form
  caches a response route (`path.json(..., () => [cache({ ttl })])`), and
  `cache(false)` there opts the path out of an enclosing `cache()`. The path's
  handler now runs under the `cache()` guards, so a header write or a
  `cookies()` read in it throws
  ([#919](https://github.com/rangojs/rango/pull/919)).
- An async intercept handler that rejected while the intercept's async
  `layout()` or one of its loaders was still pending raised an
  `unhandledRejection`, which under Node's default
  `--unhandled-rejections=throw` can crash the process. The modal slot still
  renders the declaring layout's `errorBoundary()` with a 500, and the
  rejection is now handled ([#899](https://github.com/rangojs/rango/pull/899)).
- An intercept declared in a layout with no routes of its own ignored its
  ancestors' `errorBoundary()` and `notFoundBoundary()`: a handler throw or
  `notFound()` rendered the default "Internal Server Error" / "Not Found"
  fallback, and a loader error rendered no fallback. The boundary lookup now
  continues from the routeless layout to the layout that holds it and that
  layout's ancestors, which also gives the routeless layout's own loaders a
  boundary. A boundary on the routeless layout itself still wins, and the
  status stays 500 / 404 ([#903](https://github.com/rangojs/rango/pull/903)).
- A loader with its own `cache()` replays the handle pushes of the loaders it
  awaits through `ctx.use` (#877 above). When a sibling DSL loader or the
  handler also read that dependency, the dependency still ran live on a hit,
  so its push appeared twice (a crumb without `href`, or any handle that does
  not dedupe); on a stale hit the background refresh took the dependency's
  only run and the push could be missing. Each dependency's pushes now reach
  the page once per request: if the dependency runs live after the replay, its
  live value replaces the replayed one in place; if it ran first, the replay
  skips it. A replacement that lands after the document's handle snapshot
  reaches the client after hydration, like any late loader push. 0.16.0
  showed one push; this was a regression from #877
  ([#905](https://github.com/rangojs/rango/pull/905)).
- A `"use cache"` function records the handle pushes of loaders it reads
  through `ctx.use`. When the handler or a DSL loader also read that loader,
  a hit appended the recorded push and the loader ran live too, so the push
  showed twice (a crumb without `href`, or any handle that does not dedupe).
  On a stale hit the background refresh took the loader's only run, so the
  page kept the stale push. Each loader's pushes now reach the page once per
  request, as with a loader's own `cache()` (#905 above): a live run after
  the hit replaces the replayed value in place, a run before it makes the hit
  skip it, and a loader read only inside the function is replayed once. The
  function's own pushes replay as before. An entry written before this change
  does not record which loader pushed, so it replays in full, and still shows
  such a push twice, until it expires or its stale refresh rewrites it. This
  had happened since 0.16.0 ([#938](https://github.com/rangojs/rango/pull/938)).
- On a `ppr` route, a string, number or boolean handle value pushed during the
  shell capture by a loader that an `ssr: false` loader awaits through
  `ctx.use()`, or replayed from an `ssr: false` loader's own `cache()`, was
  recorded into the shell. A hit that replays the record ran that loader again,
  so `useHandle` returned the value twice and hydration did not match the
  prelude, which showed it once. These pushes are now left out of the record,
  as object values already were. An `ssr: false` loader's own settled pushes
  are still recorded (#875 above)
  ([#895](https://github.com/rangojs/rango/pull/895)).
- The stale-route refresh and proactive caching appended the re-render's
  `transition({ when })` predicates to the live request. When the refresh got
  there before the response's transition gate ran, the gate evaluated the
  predicate on the stale hit, where values set by the cached handler with
  `ctx.set()` are missing, so the stored transition could be dropped and the
  navigation streamed its `loading()` fallback instead of holding. With
  `debugPerformance`, a loader called from a handler during the refresh also
  showed up in the stale response's Server-Timing. Both background lanes now
  keep their own predicate list and record no metrics; a stale hit always
  replays its stored transition
  ([#892](https://github.com/rangojs/rango/pull/892)).
- The stale-route refresh and proactive caching wrote to the live request's
  response: `header()`, `setCookie()` / `deleteCookie()`, `setStatus()`
  (including the 500 or 404 an error or not-found boundary sets) and
  `onResponse()` callbacks. Depending on timing, a stale hit could go out with
  a header, a `Set-Cookie` or an `onResponse` transform from the refresh, or
  with status 500 when the refresh's handler threw. The background render now
  writes to a throwaway response that is never merged, so a stale hit matches
  a fresh hit. Writes inside the `cache()` boundary still throw in the
  refresh, as on a miss ([#901](https://github.com/rangojs/rango/pull/901)).
- A stale-route refresh whose handler threw or called `notFound()` wrote its
  error or not-found boundary render over the stale entry with a fresh `ttl`,
  so every hit served the error page until the entry expired or a later
  refresh succeeded. A background render that ends with a non-200 status is
  no longer written, as a miss never stores one: the stale entry keeps
  serving, and the next stale read after the store's revalidation marker
  lapses (30 s in `CFCacheStore` and `VercelCacheStore`) refreshes again.
  Proactive caching follows the same rule
  ([#904](https://github.com/rangojs/rango/pull/904)).
- A route under `cache()` whose handler resolved but whose tree held an async
  server component that threw during the cache write was stored with a Flight
  error row, and every hit rendered the error boundary until the entry
  expired, even after the upstream recovered. Flight reports such a throw
  through `onError` and completes, and the status stays 200, so the non-200
  gate did not see it. The entry is now not written, and the skipped write is
  reported to `onError` with phase `"cache"` and category `"cache-write"`. The
  next request renders fresh; on a stale-hit refresh the stale entry keeps
  serving ([#910](https://github.com/rangojs/rango/pull/910)).
- The same rule now covers a `"use cache"` result, a loader's own `cache()`
  value, and the handle values recorded with any of these or with a route
  `cache()`. A value holding an async component that threw or a promise that
  rejected was stored with an error row, so every hit rendered the error
  boundary or the replayed handle promise rejected (React error #441). The
  entry is now not written, and the failure is reported as `cache-write` on a
  miss or `stale-revalidation` on a stale refresh, which keeps the stale entry.
  A handle value that fails to encode refuses the whole entry, since a hit
  without its handle record would serve a page missing its title or
  breadcrumbs. A deterministic non-serializable value (a function or class
  instance) was stored and then failed to decode on every hit; it is now
  reported as `cache-write` on each miss and never stored
  ([#916](https://github.com/rangojs/rango/pull/916)).
- The document cache (`createDocumentCacheMiddleware`, `s-maxage`) and the PPR
  shell capture stored a render in which a component threw after the response
  started streaming, such as an async server component whose fetch failed, or
  a client component that threw during SSR inside `<Suspense>`. Flight and
  Fizz report such an error through `onError` and finish with an error row or
  an errored Suspense boundary, the status stays 200, and every hit served the
  error until the TTL expired. The document cache now skips the write
  (`cache-write`), and a stale refresh that errors keeps the stale entry; the
  shell capture stores nothing and backs the key off. The current response is
  unchanged. A Flight error the router already reported as `"rendering"` is
  not reported again, so the skip shows only as a `[DocumentCache]` or
  `[ShellCache]` log line. A loader error behind `loading()` never reaches
  `onError`, so that render is still stored. `renderHTML` now logs Fizz errors
  with `console.error(error)`, without React's dev "[Server]" badge
  ([#920](https://github.com/rangojs/rango/pull/920)).
- A `layout()` after a bare `cache()` in a layout's children, as in
  `layout(<AppShell />, () => [path("/a", A, { name: "a" }), cache({ ttl: 60 }), layout(<PromoBanner />)])`,
  never rendered on the routes before the `cache()`. It now wraps every route
  of the layout, as it does without the `cache()`: live on the routes before
  the `cache()`, cached with the routes after it. On a route after the
  `cache()`, a `parallel()` after it no longer runs twice on a miss and once,
  discarded, on a hit, and a `middleware()` after it no longer runs twice.
  Routeless entries nested in a routeless entry, such as a `layout()` in a
  `cache(o, () => [...])` or `transition(cfg, () => [...])` with no routes,
  render too ([#922](https://github.com/rangojs/rango/pull/922)).
- A `cache()` inside a routeless `layout()`, `middleware()` or `transition()`
  wrapper in a path, as in
  `path("/p", Page, { name: "p" }, () => [layout(<Chrome />, () => [cache({ ttl: 300 })])])`,
  cached nothing. It now caches that path, like a `cache()` among the path's
  own children (#919), and the path's handler runs under the `cache()` guards
  ([#922](https://github.com/rangojs/rango/pull/922)).
- A GET for a page with `?__prerender_collect` in its URL returned the route's
  serialized segments, handle data, route name and params as
  `application/json` instead of the page, in production as well as dev, and
  skipped SSR and PPR shell serving. Nothing has sent that parameter since
  prerendering moved to `matchForPrerender`, so the handler is removed. Such a
  request now renders the page like any other, and `__prerender_collect` is no
  longer excluded from cache keys
  ([#931](https://github.com/rangojs/rango/pull/931)).
- A PPR shell could be stored with a Flight error row in the snapshot record
  of an `ssr: false` loader, and every shell hit seeded the loader from it.
  The capture encodes each such loader value a second time to pin it, and did
  not check that encode for errors. A server component in the value that threw
  only on that run was stored, and so was a value Flight cannot encode (a
  function, a class instance, a promise inside a `Map` that rejects) at build
  time, where the capture refuses only on SSR errors. The capture now stores
  nothing, reports `cache-write` and backs the key off, the same as a shell
  component that throws (#920); a build-time capture skips the shell and the
  route keeps runtime capture
  ([#932](https://github.com/rangojs/rango/pull/932)).
- An `errorBoundary()`, `notFoundBoundary()` or `intercept()` declared in a
  routeless entry nested in another one was never found: a `layout()` after a
  bare `cache()` (for the routes before the `cache()`), or a `layout()` in a
  routeless `transition(cfg, () => [...])` or `cache(o, () => [...])`. A
  handler error, `notFound()` or server action error rendered an ancestor's
  boundary or the default fallback, and the intercept neither opened on a soft
  navigation nor was pre-rendered. These lookups now walk nested routeless
  entries in the same order as the first level: the entry's own, then its
  routeless entries in render order, then the parent. The build also
  pre-renders an intercept declared directly after a bare `cache()` once
  instead of twice for the routes after it
  ([#933](https://github.com/rangojs/rango/pull/933)).
- On a `ppr` route, a PPR shell hit restored the handle pushes an `ssr: false`
  loader made during the shell capture, and the loader's re-run on the hit
  pushed them again. A handle that does not dedupe by key, such as a custom
  handle or a crumb without an `href`, showed the value twice, and hydration
  did not match the prelude, which showed it once. The re-run's pushes now
  replace the restored ones in place, so each value appears once and the
  live value wins; a push that lands after the document's handle data was
  sent reaches the client after hydration. With the loader's own `cache()`,
  a hit on that cache no longer replays them a second time. The record gains
  an optional `handleOwners` field on `CachedEntryData`; a custom
  `SegmentCacheStore` that stores the whole entry keeps it, and a record
  without it restores as before. Shell entries from an earlier build are
  already recaptured by the build-version gate. This supersedes the #875
  known-limitation note under Docs below
  ([#936](https://github.com/rangojs/rango/pull/936)).
- A `"use cache"` hit can be asserted through the testing primitives. The
  `@vitejs/plugin-rsc/rsc` stub that `rangoTestAliases()` installs threw from
  its encoder and serializer, so a cached function run through
  `renderHandler` or `runLoader` with a seeded `cacheStore` never wrote an
  entry and ran on every call, although the testing skill said a seeded store
  asserts real cache behavior. Under the react-server condition (the Flight
  project) the stub now runs the vendored react-server-dom builds plugin-rsc
  wraps. The body runs once across calls, the value round-trips through
  Flight, and an error row is not stored. The write is a background
  (`waitUntil`) task the primitives do not await: a call before it lands joins
  the still-running execution, and a call after it reads the store. In the
  node project React's server build does not load, so calls still run
  uncached, and any other failure to load the Flight builds now throws.
  A function written with the directive also stayed a plain function in a
  test: `rango()` runs the `"use cache"` transform only in its `rsc`
  environment, and Vitest transforms in `ssr`. The new
  `rangoUseCacheTransform()` from `@rangojs/router/testing/vitest` runs the
  same transform in a Vitest project, with the ids `vite dev` emits; add it to
  the Flight project's `plugins` next to `rangoUseClientTransform()`
  ([#944](https://github.com/rangojs/rango/pull/944)).

### Docs

- READMEs, every shipped skill, `packages/rangojs-router/docs`, and the docs
  site were checked against source. Corrected examples include the intercept
  modal wrapper rendering `<Outlet />`, server `errorBoundary()` fallbacks
  receiving only `{ error }`, the i18n middleware no longer reading
  `ctx.params`, and `revalidate()` examples narrowing with
  `ctx.isAction() ? ctx.isAction(X) : undefined`. The docs site gains
  `testing` and `client-urls` guides
  ([#869](https://github.com/rangojs/rango/pull/869)).
- `useLoader().isLoading` on a held navigation follows the loader family
  (`$$id`), not the segment: a persisting layout that reads the same
  `createLoader` reports `true` too. Documented as designed in the `hooks` and
  `view-transitions` skills; the 0.16.0 entry below is amended
  ([#868](https://github.com/rangojs/rango/pull/868)).
- A bake-lane (`ssr: false`) loader re-runs on every PPR shell hit, and the
  hit also replays its captured handle pushes, so a handle that does not
  dedupe by key shows them twice. Documented in the `ppr` and `shell-manifest`
  skills and guides; `Meta` and `Breadcrumbs` dedupe and are unaffected. No
  runtime change ([#875](https://github.com/rangojs/rango/pull/875)).
  Superseded: the hit now replaces those pushes (see Fixes above).
- The `server-actions` skill documents the default CSRF origin check (the
  Origin/Referer vs Host rule, the 403 rejection, and what it does not cover);
  the `response-routes` skill says response routes are outside it and shows a
  `requireSameOrigin` middleware
  ([#881](https://github.com/rangojs/rango/pull/881)).
- The `intercept` skill and the `intercepting-routes` guide list `route` among
  an intercept's allowed `use()` items and say the boundary lookup from a
  routeless declaring layout continues upward. The `handler-use` skill
  documents that `intercept()` checks its explicit `use()` and the handler's
  `.use` together at runtime (#879), and that modal chrome is a `layout()` with
  no `use()` items of its own. `route-definition-rules.md` and the internal
  reference docs were corrected for drift found reviewing v0.16.0..main
  ([#903](https://github.com/rangojs/rango/pull/903)).

### Internal

- Playwright `globalTimeout` (10 min) applies only under CI; a local full
  dev + production run is no longer cut off behind a passing summary
  ([#866](https://github.com/rangojs/rango/pull/866)).
- Local e2e server reuse probes `GET /` for an app-specific marker and fails
  with the `lsof` listener instead of reusing a foreign process on the port
  ([#867](https://github.com/rangojs/rango/pull/867)).
- Origin-guard e2e (dev + production) sends a cross-site no-JS form post and a
  cross-site RSC action call to a real action: both get 403 and the action
  never runs; a same-origin control runs it
  ([#887](https://github.com/rangojs/rango/pull/887)).
- `@playwright/test` moves to `^1.62.0` in every workspace package that
  declares it (the lockfile resolves 1.63.0). 1.57 dropped empty multipart
  fields, so a posted server-action form lost its `$ACTION_ID_` field. The
  origin-guard no-JS case now runs urlencoded and multipart (dev +
  production). The router's `@playwright/test` peer range stays `^1.49.1`
  ([#890](https://github.com/rangojs/rango/pull/890)).
- Local e2e server reuse probes with `Host: localhost:<port>`, the Host the
  suites send, so this checkout's host-fixture servers from an earlier run are
  reused instead of rejected as foreign. The router and cloudflare-basic
  Playwright webServers call `./node_modules/.bin/vite` directly, so they also
  start in a git worktree with symlinked `node_modules`
  ([#891](https://github.com/rangojs/rango/pull/891)).
- Unit tests pin that a route handler under `loading()` that rejects after the
  200 has gone out is never written to the route cache, on the miss, stale
  refresh, proactive caching, partial navigation, parallel-slot and intercept
  lanes. No runtime change ([#908](https://github.com/rangojs/rango/pull/908)).

## 0.16.0 (2026-09-20)

### `useLoader().isLoading` is true for data held on screen while a navigation re-runs its loader

When a navigation keeps the current content visible while its loader re-runs
(a `transition()` same-route nav such as `/products/1 -> /products/2`, a
same-structure search/filter nav), the reader still showing the old data now
reports `isLoading: true` from the moment the new tree is committed until the
commit that swaps `data`, so a stale indicator can be rendered from it. The
flag never flashes back to `false` on the old data: every transition commit
announces the loader streams the committed tree is still receiving
(`announcePendingStreams` in `loader-store.ts`, called inside the
`startTransition` in `browser/partial-update.ts`), and the hook answers with a
`useOptimistic` pin that React reverts in the commit that brings the new data.
Loaders the navigation does not re-run keep their data and stay `false`. The
pin follows the loader family (`$$id`), not the segment: if the same
`createLoader` is also registered on a persisting layout, that layout's
`useLoader` reports true too — the loader is in flight, even though the
layout copy is not replaced. A fully-prefetched nav commits settled data and
flags nothing; a cold navigation that remounts the route is unchanged (the
read suspends to its fallback); an ephemeral `useFetchLoader` read outside
route context is never pinned. Pinned
dev and production in the test-app (`/swr-product/:id`, and `/tx-group-a/:id`
with a persisting layout loader) and cloudflare-basic (`/features/:slug`).

### A layout over a wrapper-form `transition()` block no longer wraps every sibling route

`layout(Shell, () => [transition(cfg, () => [routes])])`, the shape the
view-transitions guide recommends, was classified as an orphan (routeless)
layout because the orphan check could not see routes inside a transition
block. Orphans are pushed onto the parent's wrapper list and render around the
parent's entire content, so `Shell`, and any `loader()`, `middleware()` or
`loading()` on it, applied to every sibling route of its parent instead of its
own routes. The wrapper-form transition item now carries its children and the
check recurses through any item that does; the same change covers `cache()`
and `middleware()` blocks over a transition block, and a lazy `include()`
inside a transition block is now discovered. Child-form `transition(cfg)` and
routeless transition blocks are unchanged (still orphan wrappers).

### Streaming Suspense boundaries are no longer client-rendered by the theme provider's mount re-sync

Every page load re-rendered `ThemeProvider` from its mount effect (`mounted`,
system theme, stored-theme re-sync) and published a NEW context object even
when no field changed. A provider value change propagates to every dehydrated
Suspense boundary still waiting on the streamed document (React marks them
conservatively; it cannot see their consumers), and React then abandons the
server HTML for those boundaries and client-renders them from the Flight
payload. On a page whose shell hydrates before a `loading()` boundary
finishes streaming, that discarded the outlined server markup and, until the
boundary's `$RC` script ran, left a hidden duplicate of the content in the
document. The context value now keeps its identity across the re-sync when its
fields are unchanged, so a pending boundary stays dehydrated and adopts the
server HTML. `resolvedTheme` also no longer reports `"light"` before mount for
a concrete `defaultTheme` rendered without `initialTheme` (standalone
`ThemeProvider`, `renderRoute`); it reports the theme from the first render
instead of flipping at mount. Root cause of the dev-only `use-cache-inline-action` flake
(strict-mode locator hit both copies). Still open: when the re-sync genuinely
changes a field (dark system theme, a stored theme differing from the
server's), the value must publish and a boundary pending at that moment is
still client-rendered; wrapping the re-sync in `startTransition` was measured
and does not help (React retries on a hydration lane and client-renders
anyway). Unit: `theme-provider.test.tsx` "context value identity across the
mount re-sync". E2e (dev + production, test-app and cloudflare-basic):
`streamed-boundary-adoption.test.ts` pins that every server boundary marker
survives in the settled DOM.

### Dependencies: `@vitejs/plugin-rsc` `^0.5.35`

0.5.35 adds Node stream entry points (`/rsc/server.node`, `/rsc/client.node`,
`/ssr.node`, `/rsc/static.node`); the rest is dependency churn. Nothing in the
router adopts them: the Flight and SSR layers stay on the Web-stream entries in
every preset. The benchmark behind that decision (Flight unchanged, SSR gain
inside request noise once the Flight tee and `injectRSCPayload` stay Web
streams) is recorded in `docs/internal/why-web-streams-everywhere.md`.

## 0.15.1 (2026-09-14)

### `{ ssr: false }` loaders that redirect or notFound no longer 500 the document

A `loader(Def, { ssr: false })` settles before the document flushes, and its
read site decodes synchronously. When the loader threw `redirect()` or
`notFound()`, that decode threw inside the Fizz shell (flagged content renders
without a Suspense boundary, and a layout reader sits above every boundary),
so the document was a 500 with the dev overlay instead of the documented 200
plus client replace. The server tree builder now resolves the settled signal
itself, the same way the aggregate forceAwait/action path already did: a
redirect replaces the whole page with the redirect carrier (200 document, the
client replaces on hydration; any ancestor read is skipped), and a notFound
renders the not-found UI at the owning segment with the real 404 the flag
already guaranteed. A flagged loader error that has an `errorBoundary()`
fallback takes the same route (fallback planted, no shell throw). Build-shell
capture now refuses to bake a flagged loader that settled with a signal, the
same way it already refused a rejected one, so a redirect can never be frozen
into a shell every visitor shares. Pinned dev and production in the test-app
and cloudflare-basic (`client-urls-ssr-signals` fixtures: layout-owned,
route-owned, and layout-reads-child redirect readers, plus a notFound page).

## 0.15.0 (2026-09-13)

### Loader bodies must not carry `"use server"`

The Vite plugin now rejects an inline `"use server"` directive inside a
`createLoader()` callback, in dev and build:

```
[rango] createLoader() body at src/catalog.loader.ts:3 carries a "use server" directive. ...
```

The directive never meant "server only". It tells the RSC toolchain to hoist
the body and register it as a client-callable server reference, so every
loader written that way was also reachable as an action through
`?_rsc_action=<id>` with caller-supplied arguments. Loader bodies already run
only on the server, addressed by id, so the directive did nothing useful.
Every example in the docs, skills, and in-repo apps used to carry it; all of
them are updated. Migration is deleting that one line per loader. For a
build-time guarantee that a module never reaches the client graph, use
`import "server-only"`.

Two related contracts are now pinned by dev and production e2e in both the
test-app and cloudflare-basic (`client-urls-vars` fixtures): route
`middleware()` variables set with `ctx.set()` (a `createVar()` token or a
string key) are visible to `clientUrls()` group loaders on document loads and
partial navigations; and the `_rsc_loader` fetch lane (`useFetchLoader()`,
`load()`, `useRefreshLoaders()`) runs only global `router.use()` middleware
plus the loader's own `{ middleware }` list, never the route chain, so
`createLoader(fn, true)` sees none of those variables. The loader skill now
says so next to the `true` example.

## 0.14.0 (2026-09-13)

The instance a client route group renders optimistically now survives the
canonical commit: state entered while the server is still responding is kept,
effects run once, and same-route param navigations inside a group hold the
previous content until the new data lands. Minor bump for the changed
same-route behavior; no DSL change.

### Breaking: group-stable segment for `clientUrls()` ([#852](https://github.com/rangojs/rango/pull/852))

0.13.0 rendered the destination of an in-group navigation before the server
responded, but the canonical commit still mounted the destination as a new
segment, so the instance the user was already interacting with was replaced.
Every route of one group mount now shares a segment key, the group's routes
get one wrapper shape, and `ClientUrlsRoot` renders the same wrapper chain in
both states, so the commit reconciles into the same position.

- Text typed into a field during the wait survives the commit; the
  destination's mount effect runs once instead of twice.
- Same-route param navigations inside a group (`/items/1` -> `/items/2`) now
  hold the previous content until the new data lands instead of remounting
  with a fresh skeleton. `transition()` in a group configures the
  view-transition animation; it no longer changes whether content is held.
  Server routes outside a group keep the param-bearing key and the
  `transition()` opt-in.
- A navigation that presented optimistically commits in the transition lane,
  so a read that still suspends holds the presented content instead of
  flashing a fallback.
- `loading()` on a group route is now the `Suspense` boundary inside the
  client root rather than a segment-level `LoaderBoundary`; the fallback and
  the reads are the same. Server-side semantics are untouched: `loading()`
  still masks loaders for PPR shell capture and drives SSR.
- The streamed loader error boundary resets its caught marker when the route
  or params change. As a surviving instance it kept rendering a loader
  redirect for the previous route; a redirect, `notFound()`, or error fallback
  caught for one route no longer leaks into the next.

Hard loads, prefetch, intercept targets, redirects, and errors are unchanged.
Design and mechanics: `docs/design/client-urls-optimistic-destination.md`.

## 0.13.0 (2026-09-12)

Client route groups are instant by default: a cross-route navigation inside a
`clientUrls()` group now renders the destination component before the server
responds. `loading()` becomes the optional route-level boundary around that
render instead of the only way to present anything early. Minor bump: the DSL
is unchanged, but the runtime contract for `useLoader` and the route hooks
inside a group changes.

### Breaking: `clientUrls()` renders the destination optimistically by default ([#850](https://github.com/rangojs/rango/pull/850))

Before, an in-group navigation showed the destination's `loading()` if it had
one and otherwise kept the origin page on screen with `useOutlet().pending`
until the canonical response committed. Now the destination component
renders at once, in a transition lane:

- `useLoader()` on a destination loader suspends until the canonical commit
  instead of throwing "not found in context". It suspends into the route's
  `loading()` when declared, into the nearest inline `<Suspense>` inside the
  component otherwise, and a destination with no boundary at all keeps the
  origin visible exactly as before (React holds the previous content in the
  transition lane).
- `useParams`, `usePathname`, and `useSearchParams` inside the rendered
  destination describe the destination (the local match's params, the target
  pathname and search). Outside the optimistic branch — chrome above the
  group, the URL bar, history, `useNavigation`, `useLinkStatus` — they keep
  the committed location until the server confirms; a redirect or error
  discards the branch and its values.
- The canonical commit after an optimistic presentation is tagged with a
  dedicated transition type that router `<ViewTransition>` boundaries map to
  `none`, so a `transition()` route animates once, at the click, not again
  when the identical content commits.
- The optimistically rendered instance is replaced by the committed segment
  when the response lands: local state entered during the window does not
  survive and effects run once per instance. A group-stable segment that
  keeps the instance alive is the documented follow-up.

Unchanged: hard loads still await middleware and `loader(Def, { ssr: false })`;
same-route param and search navigations keep held data and the `transition()`
hold; fully prefetched clicks commit from cache; intercept targets decline
local presentation; middleware and loader redirects or errors replace the
optimistic branch. There is no per-route opt-out: a route whose shell must
not render before authorization belongs in `urls()`.

Placement rule: a `useLinkStatus` or `useNavigation` reader inside content
the optimistic layer swaps unmounts at click; keep such readers in chrome
that survives the swap. Design and rationale:
`docs/design/client-urls-optimistic-destination.md`.

## 0.12.4 (2026-09-11)

Bug-fix release: the async `include()` form now mounts a `clientUrls()` module
directly, so a server `urls()` wrapper module is no longer needed to code-split
a client route group.

### Fix: async `include()` resolves a `clientUrls()` module directly ([#848](https://github.com/rangojs/rango/pull/848))

`include("/portal", () => import("./portal.client.js"), { name: "portal" })`
rejected a module whose default export is a `clientUrls()` definition
("include() provider ... must resolve to a urls() value") at the first request
into the prefix and at build-time discovery, while the eager
`include("/portal", portalUrls)` form and static route-type generation both
accepted it. The provider resolver now adapts a `clientUrls()` source (the
definition object, or its server-side client reference) through the same
adapter the eager mount uses, and route names infer through the thunk. No
startup saving comes with the async form for a client group — a `"use client"`
module is only a reference stub in the RSC graph — so pick whichever keeps
your mounts uniform. The nested caveat is unchanged: a client group mounted
inside an async `urls()` module still needs explicit names on every segment.

- Covered by runtime, build-time, and public-testing-primitive unit tests, dev +
  production e2e in the test-app and cloudflare-basic, and a local HMR test that
  adds and removes routes in the async-mounted module.
- The cloudflare-basic router-chunk bundle ratchet is re-baselined from 43 KB to
  44 KB: main measured 44031B against the 44032B limit, and this change adds
  5 B of client-reference registration-order noise, no runtime.

## 0.12.3 (2026-09-10)

Docs-and-skill release for React 19.3, with no runtime change: the shipped
`view-transitions` skill now says the `<ViewTransition>` layer works on stable
React 19.3+ (it is feature-detected, so 0.12.2 already activates it there), and
documents the transient duplicate host during a transition commit and the
doubled hydration effects in dev StrictMode that come with 19.3.

### Dependencies: React 19.3 in the workspace catalog ([#842](https://github.com/rangojs/rango/pull/842))

`react` / `react-dom` move to `^19.3.0` for every app in this repo. The router's
peer range stays `>=19.2.8 <20`, so consumers on 19.2.8 are unaffected; 19.3
is now what the e2e suites run against. Two things change on React 19.3
itself, both feature-detected rather than gated on the version:

- `transition()` now wraps segment content in React's `<ViewTransition>` on
  stable React, because 19.3 exports `ViewTransition` / `addTransitionType`.
  On 19.2 that layer is still a no-op and only the `startTransition` content
  hold applies. The view-transitions guide, skill, and internal docs no longer
  say the animation layer needs an experimental build. Tests that assert on
  a `transition()` route with strict Playwright locators can now hit the
  transient duplicate host during a transition commit; both docs gained a
  testing note and `tests/cloudflare-basic/e2e/location-state.test.ts` shows
  the fix.
- In development with StrictMode on (the default), hydration effects now run
  twice as well as the render (React 19.3 double-invokes effects during
  hydration, react#35961). The `hook-render-stability` e2e contract is updated
  from one hydration commit to two; production and `strictMode: false` are
  unchanged.

## 0.12.2 (2026-09-05)

React Compiler is now documented and tested through `@vitejs/plugin-react`
6.1's native `compiler` option. The `react-compiler` skill shipped in this
package describes the one-flag setup and keeps the Babel wiring as a fallback.
No runtime changes.

### Docs: React Compiler via plugin-react 6.1's native `compiler` option ([#840](https://github.com/rangojs/rango/pull/840))

The documented React Compiler wiring is now `react({ compiler: true })` on
`@vitejs/plugin-react` 6.1 with its optional peer `oxc-transform-react`, in
place of the Babel pair (`@rolldown/plugin-babel` + `reactCompilerPreset()`).
The `react-compiler` skill and the docs guide cover the native option: the
client-only contract (`consumer !== "server"`), `logDiagnostics`, and the
version coupling between `oxc-transform-react` and plugin-react's peer range
(pin the range plugin-react declares; a newer binding fails npm's resolver).
The Babel wiring stays documented as a fallback. No router code changed;
Rango's compiler apps (e2e-basic, vite-rsc-demo, cloudflare-basic) run the
native option in dev and production e2e.

## 0.12.1 (2026-08-31)

Standalone Vite 8 consumers can assemble the Vercel function launcher without
esbuild, and consumer Flight tests that import `"use client"` islands no
longer need a direct `@vitejs/plugin-rsc` dependency.

### Fixed: bundle the vercel function launcher with rolldown ([#838](https://github.com/rangojs/rango/pull/838))

Vite 8 no longer ships esbuild, so a standalone `preset: "vercel"` consumer
failed at assemble with "esbuild ships with Vite". The launcher is now
bundled with rolldown (a production dependency of Vite 8), resolved through
the app's vite install. `srvx` and `@vercel/functions` stay inlined;
`./rsc/index.js` stays a runtime-relative external.

### Fixed: resolve plugin-rsc vendor from the router in rangoUseClientTransform ([#838](https://github.com/rangojs/rango/pull/838))

`rangoUseClientTransform()` injected
`@vitejs/plugin-rsc/vendor/react-server-dom/server.edge` into consumer
`"use client"` modules. Consumer apps do not depend on plugin-rsc, so
`renderServerTree` of an island failed to load. The vendor file is now
resolved from `@rangojs/router` and injected as a file URL.

## 0.12.0 (2026-08-28)

Adopts `@vitejs/plugin-rsc` 0.5.34 (`getClientEntryUrl`, split `/rsc/server`
and `/rsc/client` runtimes) and restores file-level `"use cache"` wrap when
Vite/oxc emit `directive: null` on a sibling handler. 0.5.34 is a hard floor
— upgrade the peer with the router.

### Fixed: hoist `"use cache"` when sibling handlers have `directive: null` ([#836](https://github.com/rangojs/rango/pull/836))

Inline `"use cache"` hoist against `@vitejs/plugin-rsc` 0.5.34: strip
`directive: null` fields Vite/oxc now emit on ordinary ExpressionStatements
before calling `transformHoistInlineDirective`. 0.5.34's `matchDirective`
does `stmt.directive.match(...)` after `"directive" in node`, so a file that
mixes a cached function with a sibling handler whose first statement is an
expression threw and the wrap was dropped (cache-tag / inline-handler e2e
never hit).

### Dependencies: `@vitejs/plugin-rsc` `^0.5.34` ([#836](https://github.com/rangojs/rango/pull/836))

Generated SSR entries use `getClientEntryUrl()` for `headScripts: "preinit"`
instead of the deprecated `loadBootstrapScriptContent`. RSC runtime imports
split onto `@vitejs/plugin-rsc/rsc/server` and `/rsc/client`. File-level
`"use cache"` leaves mixed `"use server"` exports for plugin-rsc — both the
hoisted `$$hoist_*` helpers and the `registerServerReference` rebinds of the
original export names.

0.5.34 is a hard floor: `@vitejs/plugin-rsc` is a singleton peer, and pnpm
resolves an in-range older install (0.5.31-0.5.33) with only a warning —
such an install then fails module linking at boot (`/rsc/server`,
`/rsc/client`, and `ssr`'s `getClientEntryUrl` do not exist there). Upgrade
the peer together with the router.

`SSRDependencies.loadBootstrapScriptContent` is now optional (a
`headScripts: "preinit"` entry uses `getClientEntryUrl` instead);
`createSSRHandler`/`createShellCaptureHandler` throw at construction when
neither bootstrap dependency is usable, instead of per-request.

## 0.11.0 (2026-08-18)

Client `revalidate()` now receives the same callable `isAction(...refs)`
matcher as the server predicate. This is a breaking type/shape change: the
old boolean truthiness check stays compiling but always takes the "is an
action" branch.

### Breaking: clientUrls `revalidate()` gets the callable `isAction()` matcher ([#834](https://github.com/rangojs/rango/pull/834))

`ClientRevalidateArgs.isAction` changed from a **boolean** to the same
callable `isAction(...refs)` matcher the server predicate receives. The old
truthiness idiom keeps compiling but silently inverts — a function is always
truthy — so audit any predicate written against the boolean form:

```ts
// before — boolean (now always truthy, silently returns false):
isAction ? false : defaultShouldRevalidate;
// after — call the matcher:
isAction() ? false : defaultShouldRevalidate;
```

Client predicate chains now also mirror the server's semantics exactly: a
boolean is a hard decision that short-circuits the chain, and a
`{ defaultShouldRevalidate }` verdict threads into later predicates.

## 0.10.1 (2026-08-18)

Metadata and docs refresh for the public repository — no code changes
(source diffs since 0.10.0 are comment-only).

### Changed: package metadata and npm README ([#824](https://github.com/rangojs/rango/pull/824), [#830](https://github.com/rangojs/rango/pull/830))

- The published tarball now includes the MIT `LICENSE` file; 0.10.0
  declared MIT but shipped no license text.
- `repository`, `homepage`, and `bugs` point at
  <https://github.com/rangojs/rango> instead of the pre-transfer
  private repository path.
- The README frames stability as pre-1.0 semver 0.x and recommends
  `npm install @rangojs/router@latest`; the `experimental` dist-tag is
  documented as the way to track `main` between tagged releases.

## 0.10.0 (2026-08-13)

`loader(Def, { ssr: false })` now delivers its settled value in place on
document renders — the content sits at its document position, and handle
pushes land in the captured shell. A new `rango({ progressiveChunkSize })`
option controls Fizz outlining; unset, a matched flagged loader auto-raises
the budget so React does not park the awaited markup in a trailing
`<div hidden>` + `$RC()` reveal.

### Added: in-place delivery for `{ ssr: false }` loaders ([#823](https://github.com/ivogt/vite-rsc/pull/823))

Document renders await flagged loaders before first flush and hand
`useLoader` the settled result, not a fulfilled Flight thenable. Unflagged
siblings keep streaming. Shell capture bakes the same lane so title/meta
handle pushes are in the stored prelude, not only after hydration.

```tsx
path("/products/:category", ProductList, () => [
  loader(ProductListLoader, { ssr: false }), // in the SSR HTML, in place
  loader(RecommendationsLoader),             // still streams
]),
```

`loading(false)` routes get the same stamp after their pre-flush await.
Parallel slots that own `loading()` stay on the aggregate (that is what
pins the fallback); an all-flagged slot still settles to a decoded array.

### Added: `rango({ progressiveChunkSize })` and ssr:false auto-raise ([#823](https://github.com/ivogt/vite-rsc/pull/823))

The generated SSR entry forwards React Fizz's completed-boundary outlining
budget to live `renderToReadableStream` and PPR `prerender`. Resume
inherits the capture value from postponed state.

When the option is unset and the matched chain has a flagged loader,
`createSSRHandler` auto-raises to `Number.MAX_SAFE_INTEGER` so completed
content stays inline. An explicit value disables the auto-raise. Capture
never auto-raises. `Infinity` emits as `Number.POSITIVE_INFINITY` (JSON
cannot serialize it).

```ts
// vite.config.ts — pin the budget (also disables auto-raise)
rango({ progressiveChunkSize: Number.MAX_SAFE_INTEGER });
```

Custom SSR entries set `createSSRHandler({ progressiveChunkSize })` /
`createShellCaptureHandler({ progressiveChunkSize })` the same way.

No migration. Existing `{ ssr: false }` routes pick up in-place delivery
with no config; set the option only to pin or opt out of the auto-raise.

## 0.9.1 (2026-08-03)

Dev-only patch: Cloudflare dev no longer amplifies `clientUrls()`
route-shape edits into unbounded reload work. No API changes.

### Fixed: bounded HMR reload work for `clientUrls()` edits in Cloudflare dev ([#822](https://github.com/ivogt/vite-rsc/pull/822))

Editing a `clientUrls()` module's route shape in Cloudflare dev could drive
the dev server into runaway work — a large pilot app reached the V8 heap
limit and the Vite process died. Three paths were unbounded and are now
closed:

- A router generation probed for a newer discovery epoch rendered the full
  app per probe (every 25 ms). Any probed generation now answers with an
  empty response carrying its actual epoch.
- Repeat workerd reloads fired on every mismatched probe. They now use
  100 ms – 1 s exponential backoff, and stale probe response bodies are
  cancelled instead of buffered.
- The clientUrls importer invalidation restarted a full graph traversal at
  every importer (quadratic on large graphs) and ran redundantly on
  Cloudflare, whose rediscovery already invalidates wholesale. It now
  shares one traversal set and runs only where a local module runner
  exists.

Production builds are untouched — the probe header is inert there, now
pinned by e2e in both modes — and the Node dev path keeps its existing
invalidation behavior.

## 0.9.0 (2026-07-29)

One breaking change — the loader SSR-completeness opt-in is renamed to the
knob the API already had — and an SSR correctness fix for absolute-URL
`<Link>`s.

### Breaking: `loader(Def, { ssr: false })` replaces `stream: "navigation"` ([#820](https://github.com/ivogt/vite-rsc/pull/820))

```tsx
// before
loader(ProductLoader, { stream: "navigation" }),
// after
loader(ProductLoader, { ssr: false }),
```

Migration is a grep: `stream: "navigation"` → `ssr: false`. Passing the
removed option throws a targeted error naming the replacement, on both DSL
surfaces (`urls()` and `clientUrls()`).

Semantics are unchanged — this is one vocabulary, not new behavior:
`ssr: false` on a loader means the same thing it has always meant on
`loading(fallback, { ssr: false })`, read from the other end. The flagged
loader is awaited before first flush on document requests (its data, handle
pushes, and a thrown `notFound()`'s 404 status are deterministically in the
SSR'd HTML; no fallback paints for it), client navigations keep streaming it
behind the fallback, scoping stays per-loader, and under `ppr` it remains
the bake lane. `ssr: true` is accepted as the explicit default. Serialized
clientUrls projections are unaffected (the wire format did not change).

### Fixed: absolute-URL `<Link>`s hydrate cleanly; external links are external from the first byte ([#821](https://github.com/ivogt/vite-rsc/pull/821))

`Link` classified absolute URLs against `window.location.origin`; on the
server the `ReferenceError` was silently swallowed, so SSR HTML never
carried `data-external` and every absolute-URL `<Link>` was a hydration
mismatch — genuinely external links (CMS navs pointing at another site)
only became hard navigations after the client patched the attribute in.

The server now classifies against the request origin, threaded into the
SSR navigation store through the same channels as the search seeding —
document renders, ppr shell capture, and resume all agree with what the
browser will conclude. No consumer changes; deployments behind proxies
should forward `Host`/proto correctly (the same requirement redirects
already have). Build-time prerendered shells remain host-agnostic:
absolute links in their static parts keep the internal classification.

## 0.8.0 (2026-07-28)

Edge-only ppr: `CFCacheStore` no longer requires a KV namespace for shell
caching. No breaking API changes; two new store-surface additions
(`putShell`'s `"uncacheable"` result, `SegmentCacheStore.tagHistoryInert`).

### Highlights

#### Edge-only ppr — KV-less `CFCacheStore` stores shells L1-only ([#819](https://github.com/ivogt/vite-rsc/pull/819))

Previously a `CFCacheStore` without a KV binding silently disabled ppr:
`getShell`/`putShell` no-oped, the capture scheduler never rendered, and
every `ppr` route was a permanent `x-rango-shell: MISS`. Now the same
config captures and serves shells from the per-colo Cache API alone:

```ts
cache: (env, ctx) => ({
  store: new CFCacheStore({ ctx }), // no `kv` — shells are per-colo
}),
```

First request MISS + background capture, subsequent requests in that colo
HIT — the stored prelude flushes in the first bytes, `loading()` holes
stream live. Each colo warms its own shell; that is the edge-only trade
(no cross-colo KV promotion). `workers.dev`/`pages.dev` previews work too
(the store keys L1 under its internal fallback host there).

Tag eviction mirrors the data families' purge-mode stance. With
`tagPurge`, purge-by-tag evicts shell L1 entries (they already carry the
namespaced `Cache-Tag` tokens) and the per-request memo keeps
read-your-own-writes; without it, a tagged shell warns once that
invalidation cannot reach it and expires by ttl+swr. Untagged edge-only
ppr is warning-free. With KV bound, nothing changes — shells keep the
durable generation-marker check.

Three KV-less boundaries are hard, not degraded: tagged build-manifest
shells are declined outright (`SegmentCacheStore.tagHistoryInert` — the
immutable asset could never be evicted, so the route keeps
runtime-capture semantics); a tag set whose `Cache-Tag` header overflows
is acknowledged `"uncacheable"` from `putShell` and the capture scheduler
backs the key off instead of re-rendering per MISS; and
`tagInvalidationTtl` is dead config without KV — it no longer caps L1
retention and its KV-floor validation warning no longer fires.

### Internal

- New dedicated e2e config (`tests/cloudflare-basic/playwright.edge-only.config.ts`)
  boots the app with the KV binding dropped and pins MISS → capture → HIT,
  clean HIT hydration, and the tagged build-shell decline, dev + production.

## 0.7.0 (2026-07-28)

Shell caching comes to clientUrls groups, `stream: "navigation"` loaders
become shell material under ppr, and the dev-mode client-reference dedup
gets exports-map precision. No breaking API changes; one behavioral change
for `stream: "navigation"` loaders on ppr routes (below).

### Highlights

#### `ppr` on clientUrls group routes ([#817](https://github.com/ivogt/vite-rsc/pull/817))

Group routes can now declare shell caching exactly like server pages:

```tsx
"use client";
export default clientUrls(({ path, loader, loading }) => [
  path("/", ShopFront, { ppr: { ttl: 300, swr: 120 } }, () => [
    loader(FeaturedLoader),
    loading(<GridSkeleton />),
  ]),
]);
```

The option projects through the group's JSON projection onto the
materialized server route, so the whole runtime engages unchanged: the
group's static markup freezes into a per-URL shell — its `useSearchParams`
read included, since search is part of shell identity — `loading()`
subtrees stay the live holes, and a HIT flushes the stored prelude in the
first bytes and hydrates with zero errors. The navigation axis works too:
soft navigations into a warmed group route serve the stored navigation
payload (`x-rango-ppr-replay: HIT`) and viewport prefetches enqueue
navigation-only captures.

#### `stream: "navigation"` loaders bake into the shell ([#817](https://github.com/ivogt/vite-rsc/pull/817))

The flag's document promise — data, handle pushes, and status in the HTML
before first flush — previously degraded silently under ppr: the loader
was masked like any live loader and its data arrived in the resume stream,
never the prelude. The capture lane is now per loader: a flagged loader
executes at capture and its SETTLED return is shell material (frozen for
the shell's lifetime, snapshot-pinned so HIT hydration agrees
byte-for-byte), while nested promises in the return stay live holes —
promise shape is the liveness declaration — and unflagged siblings stay
fully dynamic. `loading()` becomes optional when every loader on a route
is flagged: nothing masks, so the shell captures complete.

This is a behavioral change if you already use `stream: "navigation"` on a
ppr route: the loader's settled data is now frozen per shell lifetime
(govern freshness with `ppr.ttl`/`swr`/`tags`) instead of streaming fresh
into the resume. Express per-request material as a nested promise or move
it to an unflagged loader.

#### Exports-map-precise client-reference dedup in dev ([#816](https://github.com/ivogt/vite-rsc/pull/816))

Deep third-party `"use client"` imports (`lib/context`, not re-exported
from the package root) lost their symbols in dev — the dedup rewrote the
module to the bare package root. It now resolves the module's precise
public subpath through the package's `exports` map (star patterns
included, every candidate verified by resolving back to the same file),
falling back to the documented root-barrel behavior only when no public
subpath maps. Context identity dedupes correctly for non-barrel packages.

### Fixes

- `Static()` / `Prerender()` handler values inside `clientUrls()` are
  rejected with a targeted message naming the wrapper and pointing at the
  `ppr` path option — build-time handlers are server-DSL surface and
  cannot mount in a client group ([#818](https://github.com/ivogt/vite-rsc/pull/818)).
- `expose-action-id` adopts plugin-rsc's public `getPluginApi` and
  tolerates both server-reference manager shapes, failing loudly if
  neither matches ([#816](https://github.com/ivogt/vite-rsc/pull/816)).

### Dependencies

- `@vitejs/plugin-rsc` `^0.5.31` (carries the pluggable server-function
  registration API), react/react-dom peers to `19.2.8`
  ([#816](https://github.com/ivogt/vite-rsc/pull/816)).

### Internal

- New e2e surfaces: head-script `preload` mode (dedicated config, both
  apps) and deep client-package resolution, dev + production.
- The clientUrls group DSL scope is settled: shell caching is the `ppr`
  option and the `stream: "navigation"` bake lane; build-time
  prerendering stays with the server tree around the include.

## 0.6.0 (2026-07-28)

This release ships three large pieces: client route groups (`clientUrls()`),
streaming loader data with an implicitly-suspending `useLoader`, and a
reworked search-params surface with a React Router-style setter. One breaking
change: the `useSearchParams` return shape.

### Highlights

#### `clientUrls()` — client route groups with instant navigation, server authority ([#812](https://github.com/ivogt/vite-rsc/pull/812))

A new DSL for defining a group of client-rendered routes inside a single
`"use client"` module and mounting it in the server tree with `include()`:

```tsx
"use client";
import { clientUrls } from "@rangojs/router/client";

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(ShopLayout, () => [
    path("/", ProductGrid, { name: "index" }),
    path("/product/:slug", ProductDetail, { name: "product" }, () => [
      loader(ProductLoader),
      loading(<DetailSkeleton />),
    ]),
  ]),
]);
```

Navigation inside a group matches locally and presents instantly, while the
server keeps authority: mount-scoped middleware and guards still run on every
group navigation, loaders execute on the server and stream in, and thrown
`notFound()`/`redirect()` from a group loader behave like route authority
signals. Groups support projected per-loader `revalidate()` predicates,
module-local `intercept()` slots, a data-only `transition()` opt-in, and
per-loader `stream: "navigation"` for SSR-complete delivery. The group DSL is
deliberately minimal — error boundaries are plain React boundaries, and
parallel routes, caching, and middleware stay in the server tree around the
mount.

The full client-hook surface is settled for groups and pinned by tests:
`useMount`, `useHref`, mount-relative `useRouter().push("cart")` (relative
paths resolve against the include mount; absolute paths stay app-absolute),
the local `useReverse(routes)` form backed by per-module generated route
maps, `useLocationState` write lanes, and the rest. The review lives in
`docs/design/client-urls-hooks-review.md`.

#### Streaming loader data and implicitly-suspending `useLoader` ([#813](https://github.com/ivogt/vite-rsc/pull/813))

Loader data no longer gates rendering at the route boundary: loaders kick off
at match time and settle during Flight serialization, and `useLoader` reads
suspend at the read site to the nearest boundary — `loading()` or an inline
`<Suspense>`. `Outlet` gained a `fallback` prop as the layout-owned pending
boundary. Under ppr, value-slot loaders are live at capture: nothing from a
loader can bake into a shared shell, so per-request data stays per-request by
construction.

#### `useSearchParams` tuple with setter, and search as first-class state ([#815](https://github.com/ivogt/vite-rsc/pull/815))

`useSearchParams` now returns a React Router-style tuple:

```tsx
const [searchParams, setSearchParams] = useSearchParams();
setSearchParams({ category: "electronics" }, { replace: true, scroll: false });
setSearchParams((prev) => {
  prev.set("page", "2");
  return prev;
});
```

The setter replaces the whole search string (React Router semantics) and
navigates same-route, so loaders re-evaluate per their `revalidate()`
contract. Around it, search became first-class across the stack:

- During document SSR the hook carries the live request's real search values,
  and the browser's first render seeds from its own URL — hydration agrees,
  and search-derived branches SSR correctly instead of flickering in.
- Same-route search navigations hold previous content through the commit
  (like actions) instead of re-streaming the `loading()` fallback — filter
  UIs stop flashing skeletons.
- On ppr routes, search is part of shell identity: the shell key already
  embeds the sorted, `cache.searchParams`-filtered search, and the capture
  and resume renders now seed that same string — so a static part may read
  search and each query-string variant gets its own correct shell.

### Breaking changes

`useSearchParams` no longer returns a bare `URLSearchParams`. Destructure the
tuple:

```tsx
// before
const params = useSearchParams();
// after
const [params, setParams] = useSearchParams();
```

There is no transitional API; the old shape is gone.

### Fixes

- `redirect(url, { state })` thrown from a loader silently dropped its
  location state — streaming loaders settle after payload metadata is
  flushed, so the state never reached the wire. The state now travels on the
  loader-result marker and merges at the redirect target, so flash messages
  survive loader redirects ([#815](https://github.com/ivogt/vite-rsc/pull/815)).
- `rango generate` silently skipped modules containing only `clientUrls()` —
  the classify sniff matched the lowercase `urls(` token, which
  `"clientUrls("` does not contain. Per-module route maps now generate for
  default-exported group modules, enabling the local `useReverse` form
  ([#815](https://github.com/ivogt/vite-rsc/pull/815)).
- `revalidate()` can no longer blank an unrendered parallel slot: the
  new-segment seed is floored so a slot that never rendered keeps its
  fallback instead of emptying ([#814](https://github.com/ivogt/vite-rsc/pull/814)).
- Removed the dev warning claiming location state "will be lost" on full-page
  SSR redirects — loader redirects now deliver state on document loads, so
  the blanket claim was wrong ([#815](https://github.com/ivogt/vite-rsc/pull/815)).

### Internal

- Bundle guards: the client boot closure (bootstrap + react + router) is
  asserted free of app code, and a production probe pins that landing on a
  group route preloads its chunk in the first HTML bytes — no
  hydration-time chunk waterfall.
- The clientUrls hook-contract settlement review
  (`docs/design/client-urls-hooks-review.md`) covers the full
  `@rangojs/router/client` export surface; every row is settled and pinned.
