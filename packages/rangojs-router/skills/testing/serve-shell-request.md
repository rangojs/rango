# Testing a PPR shell — serveShellRequest

**Layer:** RSC unit (react-server project) · **Import:** `@rangojs/router/testing/flight` · **DSL it tests:** the `ppr` path option (see `/ppr`)

`serveShellRequest(router, url, options?)` serves one GET through your router's production request handler — built as `router.fetch` builds it, with the router's `nonce`, `version`, `cache` config and middleware — and settles every background task the request scheduled before it resolves. So the first request for a `ppr` route is a MISS whose real capture has stored its shell (`putShell` landed), and the next request with the same store is a real HIT: shell read, version gates, the tail replaying the handler output the capture baked (no handler runs), live loaders. A `partial` request is a real client navigation with its `x-rango-ppr-replay` decision. Flight is real.

The one stub is the HTML step (the SSR module), because `react-dom/server` does not load under the react-server condition:

| SSR step           | Under `serveShellRequest`                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `renderHTML`       | passes the Flight stream through: a document body is its Flight payload                                |
| `captureShellHTML` | stores, as the prelude, the Flight text the capture rendered before it went quiet; `postponed` is null |
| `resumeShellHTML`  | passes the tail's Flight through: a HIT body is the stored prelude, then the tail's Flight payload     |

So `prelude` is the shell as captured (Flight text, not HTML): a value the shell froze appears there, and a hole (a live loader under `loading()`) does not.

A `Prerender` route is served as in production: from the artifact `router.matchForPrerender` bakes for the URL (on its first request, kept until `resetShellTestState()`), through the production prerender store, so its handler runs once, at the bake, and never on a request. Its first `ppr` request is a MISS with a runtime capture, as a URL without a build-time shell is in production. The shell `vite build` bakes (served first in production for a URL without a query string) is not reproduced: keep that in e2e. The `env` option doubles as the bake's `buildEnv`. An on-demand route (`Prerender(..., { onDemand })`) is baked only when it is wrapped in `Passthrough()` and its `getParams()` lists the param, as a build bakes it; a plain on-demand route is not baked here, so its pages come from the prerender store alone (`router.prerender()`), and "a removed page the build baked" is a case for a `Passthrough` route or for e2e.

## API

### Options — `ServeShellRequestOptions`

| Field        | Type                                                                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cacheStore` | `SegmentCacheStore`                                                                  | The store for this request, in place of the store your `createRouter({ cache })` config returns. The rest of that config (`enabled`, `searchParams`) still applies. Omit it to use the router's own store.                                                                                                                                                                                                                                                                         |
| `env`        | `TEnv`                                                                               | Bindings, as `router.fetch(request, { env })` passes them. A function `cache` config receives them.                                                                                                                                                                                                                                                                                                                                                                                |
| `headers`    | `HeadersInit`                                                                        | Request headers (e.g. `cookie`). A document request defaults `accept` to `text/html`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `partial`    | `true \| { from?: string; segments?: string[]; prefetch?: boolean; fill?: boolean }` | Serve the navigation request the browser sends instead of a document GET: from `from` (default the site root) with `segments` mounted (default none). `prefetch: true` sends it as a `<Link>` prefetch (`X-Rango-Prefetch`), so `prefetch: false` work is deferred. `fill: true` sends the follow-up request (`_rsc_fill=1`) the browser makes after adopting a prefetch; pass the prefetch's delivered ids, without the deferred ones, as `segments`, and the same URL as `from`. |

### Returns — `ServeShellRequestResult`

| Field          | Type                                              | Meaning                                                                                                                                                                                     |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shellStatus`  | `"HIT" \| "MISS" \| null`                         | `x-rango-shell`; null when the serve path did not consider the request (not a `ppr` route, a nonce'd request, a partial request).                                                           |
| `replayStatus` | `PprReplayStatus \| null`                         | `x-rango-ppr-replay` on a partial request: `{ outcome: "HIT", freshness }` or `{ outcome: "BYPASS", reason }`.                                                                              |
| `prelude`      | `string \| undefined`                             | The prelude a HIT served (the capture's Flight text). `undefined` unless `shellStatus` is `"HIT"`.                                                                                          |
| `flight`       | `string \| undefined`                             | The Flight payload this request rendered: a HIT's tail, a document render, or a partial response. `undefined` when no Flight rendered (a redirect, a middleware response).                  |
| `key`          | `string`                                          | The shell key the serve path resolved for a document it read (MISS or HIT), request partition included. Otherwise (no `ppr`, a partial request) the URL's key without a partition.          |
| `readEntry`    | `() => Promise<ShellCacheEntry \| null>`          | Reads the document entry under `key` from the request's store (a passive `getShell`). A read: on a store with a shell memo it warms the memo, so call it after the reads you count.         |
| `readHandles`  | `() => Promise<ShellRequestHandles \| undefined>` | Decodes the response's handle data as the browser reads it: `{ hydration, late }` (see "Handles and loader data"). `undefined` when no Flight rendered.                                     |
| `readDeferred` | `() => Promise<string[] \| undefined>`            | The ids of the segments the payload marks deferred (a prefetch skipped them; the fill renders them), in payload order. `[]` when nothing was deferred, `undefined` when no Flight rendered. |
| `response`     | `Response`                                        | Status and headers. Its body is already read.                                                                                                                                               |
| `body`         | `string`                                          | The body text.                                                                                                                                                                              |

### `resetShellTestState(): Promise<void>`

A worker keeps some PPR state across requests, and so does the test process across tests: the capture's stampede guard and backoff (a refused capture backs its URL off for later tests too), the capture's and the serve path's once-per-key warnings, the build-shell manifest memo, the `Prerender` artifacts baked so far, and `CFCacheStore`'s isolate memos (shells, tag markers, tag hints), which every `CFCacheStore` shares by namespace and URL — a later test's first request can be a HIT from an earlier test's shell. `resetShellTestState()` clears all of it. Call it in `beforeEach`, never while a request is in flight. `VercelCacheStore`'s memos live on the `cache` handle you pass it: a new handle per test starts empty.

## Recipe

```ts
// test/product-shell.rsc-test.tsx — in the react-server project (./setup.md)
import { beforeEach, expect, it } from "vitest";
import { createRouter, updateTag, urls } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { runInRequestContext } from "@rangojs/router/testing";
import {
  resetShellTestState,
  serveShellRequest,
} from "@rangojs/router/testing/flight";
import { ProductPage } from "../src/pages/product"; // renders the product name
import { StockLoader } from "../src/loaders/stock"; // live stock count

const router = createRouter().routes(
  urls(({ path, loader, loading }) => [
    path("/product/:id", ProductPage, { name: "product", ppr: { tags: ["catalog"] } }, () => [
      loader(StockLoader),
      loading(<p>Checking stock…</p>),
    ]),
  ]),
);

beforeEach(() => resetShellTestState());

it("serves the captured shell and fills the stock hole live", async () => {
  const cacheStore = new MemorySegmentCacheStore();

  const miss = await serveShellRequest(router, "/product/1", { cacheStore });
  expect(miss.shellStatus).toBe("MISS"); // a normal render; the capture stored the shell

  const hit = await serveShellRequest(router, "/product/1", { cacheStore });
  expect(hit.shellStatus).toBe("HIT");
  expect(hit.prelude).toContain("Widget"); // frozen at capture
  expect(hit.prelude).not.toContain("in stock"); // the hole
  expect(hit.flight).toContain("in stock"); // rendered by this request

  await runInRequestContext(() => updateTag("catalog"), { cacheStore });
  const recapture = await serveShellRequest(router, "/product/1", { cacheStore });
  expect(recapture.shellStatus).toBe("MISS");
});

it("replays the captured segments on a client navigation", async () => {
  const cacheStore = new MemorySegmentCacheStore();
  await serveShellRequest(router, "/product/2", { cacheStore });

  const nav = await serveShellRequest(router, "/product/2", {
    cacheStore,
    partial: { from: "/" },
  });
  expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
});
```

A store built per request from a function `cache` config gets the request's execution context (`ctx`), so its own `waitUntil` writes (`CFCacheStore({ ctx })`) settle with the call. A store built outside the request with its own `waitUntil` (`VercelCacheStore`'s option) is not settled by the call. For `CFCacheStore`, stub the `caches` global and pass a KV double in `env`; for `VercelCacheStore`, pass a `cache` double. A store's shell memo then behaves as in production (count your double's reads across two HITs).

## Simulating a deploy: setBuildVersions

A stored shell is stamped with the router's document version and a HIT requires the stamp to match. In a build, `vite build` computes that version per `createRouter()`; under test there is no build, so the primitives run unversioned. `setBuildVersions` (from `@rangojs/router/testing`) installs the versions a build would ship, and calling it again with a different `document` is a deploy that changed the router:

```ts
import { setBuildVersions } from "@rangojs/router/testing";

afterEach(() => setBuildVersions()); // remove the versions: unversioned again

it("a deploy that changes the document version retires the shell", async () => {
  const cacheStore = new MemorySegmentCacheStore();
  setBuildVersions({ data: "d1", document: "h1" });

  expect(
    (await serveShellRequest(router, "/product/4", { cacheStore })).shellStatus,
  ).toBe("MISS");
  expect(
    (await serveShellRequest(router, "/product/4", { cacheStore })).shellStatus,
  ).toBe("HIT");

  setBuildVersions({ data: "d1", document: "h2" }); // new SSR output or client assets
  expect(
    (await serveShellRequest(router, "/product/4", { cacheStore })).shellStatus,
  ).toBe("MISS");
});
```

`setBuildVersions({ data, document, routers?: { [routerId]: { data, document } } })` takes the whole-build pair and, optionally, a pair per router id (a router with no entry gets the whole-build pair). `setBuildVersions()` with no argument removes them. The types `BuildVersions` and `RouterVersions` are exported too. `dispatch` sees the same versions.

## A HIT runs no handler

A HIT replays what the capture's handlers produced — their elements, the promises they passed or pushed, their handle values — and runs only middleware and loaders. Count runs to pin it:

```ts
let pageRuns = 0;
// the page handler does `pageRuns += 1` and renders `page-run-${pageRuns}`

it("a HIT runs no handler", async () => {
  const cacheStore = new MemorySegmentCacheStore();
  await serveShellRequest(router, "/product/3", { cacheStore }); // MISS + capture
  const baked = pageRuns; // the capture's run

  const hit = await serveShellRequest(router, "/product/3", { cacheStore });
  expect(hit.shellStatus).toBe("HIT");
  expect(pageRuns).toBe(baked);
  expect(hit.flight).toContain(`page-run-${baked}`);
});
```

## Request-partitioned shells

A route whose `cache()` record is partitioned by the request (`cache({ key })`, or the store's `keyGenerator`) has a shell per partition. Serve each partition with the request headers or cookies its key reads; the result's `key` is the key the serve path resolved, partition included, and `readEntry()` reads it:

```ts
// cache({ ttl: 300, key: (ctx) => `tier:${ctx.request.headers.get("x-tier")}` }, () => [
//   path("/pricing", PricingPage, { ppr: true }),
// ])
const tier = (name: string) => ({ cacheStore, headers: { "x-tier": name } });

await serveShellRequest(router, "/pricing", tier("gold")); // MISS + capture
const silver = await serveShellRequest(router, "/pricing", tier("silver"));
expect(silver.shellStatus).toBe("MISS"); // its own capture, never gold's shell
const gold = await serveShellRequest(router, "/pricing", tier("gold"));
expect(gold.shellStatus).toBe("HIT");
expect(gold.key).toBe(
  shellCacheKey(router, "/pricing", undefined, "tier:gold"),
);
// "{router.id}@localhost/pricing:shell|key%3Atier%253Agold": the router the
// shell belongs to, then the key() result namespaced as production stores it
// (issue #975).
expect(await gold.readEntry()).not.toBeNull();
```

Under nested keyed `cache()` boundaries the partition is their `key()` results composed, outermost first (see `/caching`, "Keys nest"). Pass them to `shellCacheKey` as an array and it composes them the same way:

```ts
// cache({ key: tierKey }, () => [
//   layout(TierLayout, () => [
//     cache({ key: (ctx) => `v:${variantOf(ctx)}` }, () => [path("/plans", PlansPage, { ppr: true })]),
//   ]),
// ])
expect(result.key).toBe(
  shellCacheKey(router, "/plans", undefined, ["tier:gold", "v:a"]),
);
```

A store `keyGenerator` result that partitions the record partitions the shell too, an enclosing `cache({ store })` on another store included (issue #974). Pass those results as `generated`, with any `key()` results as `keys`:

```ts
// createRouter({ cache: { store: localeStore } }), where localeStore's
// keyGenerator returns `${defaultKey}|${locale}`
expect(result.key).toBe(
  shellCacheKey(router, "/pricing", undefined, {
    generated: [`doc:${router.id}@localhost/pricing|de`],
  }),
);
```

A partial request has no HTML step, so its `key` is the URL's key without a partition: read a partitioned route's entry from a document request's result.

## Two routers on one cache store

A shell's key starts with its router's id (`shellCacheKey(router, url)`), so two routers that share a store and serve the same host and path each read and write their own (why and when: `/host-router`, "Shared cache store"). Serve both against one store to pin it:

```ts
const store = new MemorySegmentCacheStore();
// appA and appB: createRouter({ id: "app-a" | "app-b", cache: { store } }),
// each with path("/pricing", ..., { ppr: true })
const url = "http://preview.dev/pricing";

await serveShellRequest(appA, url); // MISS + capture
const fromB = await serveShellRequest(appB, url);
expect(fromB.shellStatus).toBe("MISS"); // never app A's shell
expect((await serveShellRequest(appA, url)).shellStatus).toBe("HIT");
expect((await serveShellRequest(appB, url)).shellStatus).toBe("HIT");
```

Vitest runs no Vite id transform, so give each router an explicit `id` when a test builds more than one, and do not reuse one `id` for routers with different routes in the same file: the route manifest is registered per id.

## Handles and loader data

`readHandles()` decodes the handle data the response carries, the way the browser reads it, with deferred values resolved. Each field is the raw handle data (`{ [handleId]: { [segmentId]: values[] } }`):

| Field       | What it is                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hydration` | What the document hydrates with (`metadata.handles`, read to its end before hydration starts). For a `partial` request, the last state it streamed. |
| `late`      | The states that arrived on the late channel (`metadata.handlesLate`), in order. Each replaces the client's handle data after hydration. Often `[]`. |

On a HIT the client hydrates with exactly what the shell was rendered from, so `hydration` is also what the shell's HTML holds, and whatever this request's loaders push, replace or drop is in `late` (see `/ppr`, "Handles on a shell HIT"):

```ts
// The handler pushed ctx.use(Notes)("from-handler"); a live loader pushes
// ctx.use(Notes)("in stock").
const values = (data) =>
  Object.values(data ?? {}).flatMap((s) => Object.values(s).flat());

const hit = await serveShellRequest(router, "/product/1", { cacheStore });
const handles = await hit.readHandles();
expect(values(handles.hydration)).toEqual(["from-handler"]); // the shell's HTML, hydrates clean
expect(values(handles.late.at(-1))).toEqual(["from-handler", "in stock"]); // after hydration
```

Loader data has no decoder: it rides the payload, so assert it as text in `prelude` and `flight`. `normalizeFlight` and the `flightMatchers` (`toMatchFlight`) work on the text too. A live loader's data is only in the tail.

```ts
expect(hit.flight).toContain('"stock":"in stock"');
```

## Testing `prefetch: false`

Send the prefetch with `partial: { prefetch: true }` and read which segments it deferred, then send the fill the browser would send:

```ts
const prefetch = await serveShellRequest(router, "/product/1", {
  cacheStore,
  partial: { from: "/", prefetch: true },
});
expect(await prefetch.readDeferred()).toHaveLength(1); // the flagged loader's segment

// The ids the prefetch delivered, minus the deferred ones: what the page holds.
const held = deliveredIds.filter((id) => !deferredIds.includes(id));
const fill = await serveShellRequest(router, "/product/1", {
  cacheStore,
  partial: { from: "/product/1", segments: held, fill: true },
});
expect(await fill.readDeferred()).toEqual([]); // a fill defers nothing
```

`deliveredIds` is the payload's `metadata.matched`, read from `prefetch.flight`. Count the loader's runs in your own fixture: the prefetch ran it zero times, the fill once.

## Warming a route: router.prerender()

`router.prerender()` warms a route that is not `Prerender(..., { onDemand })`
through `router.fetch` (`/prerender` → "Warm any route before traffic").
Importing `serveShellRequest` gives that handler the same HTML stub, so the
whole path runs here: warm, then serve the next visitor's request.

```tsx
class SharedMemoryStore extends MemorySegmentCacheStore {
  // The shipped store is "local" and refused; a test store says it is shared.
  readonly scope = "global" as const;
}

const router = createRouter({
  cache: { store: new SharedMemoryStore() },
}).routes(
  urls(({ path }) => [path("/product/:id", ProductPage, { ppr: true })]),
);

const result = await router.prerender({ env: {} })(
  "http://localhost/product/1",
);
expect(result).toMatchObject({ ok: true, path: "warm", status: "warmed" });

// No visitor has requested the URL: its first document is a HIT.
const hit = await serveShellRequest(router, "/product/1");
expect(hit.shellStatus).toBe("HIT");
```

- Configure the store on the router. A warm writes to the store
  `createRouter({ cache })` resolves, not to the `cacheStore` option of
  `serveShellRequest`.
- Give the target the origin `serveShellRequest` uses (`http://localhost`), as
  a full URL or with `router.prerender({ env, origin })`: cache keys carry the
  host. A path target with neither returns `skipped-no-origin`, unless the
  runner is called from inside a served request (a route handler that calls
  `router.prerender()`), where it takes that request's origin.
- To assert a replace, count handler runs or render a per-run stamp: fill the
  cache with one request, move the data, warm, then check the next request
  shows the new value and ran no handler.
- `router.fetch` binds its handler's document version once, as a production
  isolate does, so `setBuildVersions()` between two warms does not move it.

## Caveats

What the HTML stub cannot reproduce, so keep it in e2e:

- The prelude's `<body` sanity gate. A route whose production capture refuses for a root postpone (a live loader read with no `loading()` or `<Suspense>` above it) stores a shell here.
- The capture deadline. `ppr.captureTimeout` (default 15s) bounds the whole capture: the match, the handler output, then the shell render. A capture that runs out of it stores nothing and is not retried in place, here as in production, so the call waits one deadline: give such a route a short `captureTimeout` in a test (Vitest's default test timeout is 5s). One difference: when the handler output settled but the shell render does not go quiet in what is left, the stub returns no shell, while production goes on to its abort and can still store the prelude rendered by then.
- SSR render errors. In production a fizz render error during the capture refuses it (#915). The stub renders no HTML and reports none, so a shell whose client component throws during SSR is stored here. A server component that throws still refuses the capture, as in production.
- Fizz resume of the holes, bootstrap scripts, nonce injection, and browser resume.

Other caveats:

- A HIT's tail carries replayed segments as Flight fragments inside JSON strings, so their quotes are escaped (`\"`). Match plain text, or unescape before matching JSON-shaped text.
- Call `resetShellTestState()` in `beforeEach` (see above). Without it, a URL a previous test left backed off, or a shell memoized by another `CFCacheStore`, changes what the next test sees.
- `readEntry()` reads the document entry under `key`. A partial request that finds no entry captures a navigation-only entry, which is stored apart from it.
- `updateTag()` needs a request context with the store: call it through `runInRequestContext(fn, { cacheStore })` or your app's own endpoint (`dispatch`). A store refuses a capture that starts in the invalidation's millisecond (the invalidation wins) and backs the key off; `serveShellRequest` starts each request in a later millisecond than the call, so an invalidation made before the call cannot collide with it.
- GET only. Server actions are not served; test their effects with `runInRequestContext`.
- Same setup as every Flight test: the react-server condition and `rangoTestAliases()` (see [`./setup.md`](./setup.md)).

## See also

- `/ppr` — the DSL this tests; `/caching` — stores and tags
- Siblings: [`./cache-prerender.md`](./cache-prerender.md) (the shell-status helpers and the e2e recipe), [`./render-handler.md`](./render-handler.md)
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "serveShellRequest — a real PPR capture and HIT"
