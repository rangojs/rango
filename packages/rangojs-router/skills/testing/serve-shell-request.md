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

## API

### Options — `ServeShellRequestOptions`

| Field        | Type                                             | Meaning                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cacheStore` | `SegmentCacheStore`                              | The store for this request, in place of the store your `createRouter({ cache })` config returns. The rest of that config (`enabled`, `searchParams`) still applies. Omit it to use the router's own store. |
| `env`        | `TEnv`                                           | Bindings, as `router.fetch(request, { env })` passes them. A function `cache` config receives them.                                                                                                        |
| `headers`    | `HeadersInit`                                    | Request headers (e.g. `cookie`). A document request defaults `accept` to `text/html`.                                                                                                                      |
| `partial`    | `true \| { from?: string; segments?: string[] }` | Serve the navigation request the browser sends instead of a document GET: from `from` (default the site root) with `segments` mounted (default none).                                                      |

### Returns — `ServeShellRequestResult`

| Field          | Type                                     | Meaning                                                                                                                                                                             |
| -------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shellStatus`  | `"HIT" \| "MISS" \| null`                | `x-rango-shell`; null when the serve path did not consider the request (not a `ppr` route, a nonce'd request, a partial request).                                                   |
| `replayStatus` | `PprReplayStatus \| null`                | `x-rango-ppr-replay` on a partial request: `{ outcome: "HIT", freshness }` or `{ outcome: "BYPASS", reason }`.                                                                      |
| `prelude`      | `string \| undefined`                    | The prelude a HIT served (the capture's Flight text). `undefined` unless `shellStatus` is `"HIT"`.                                                                                  |
| `flight`       | `string \| undefined`                    | The Flight payload this request rendered: a HIT's tail, a document render, or a partial response. `undefined` when no Flight rendered (a redirect, a middleware response).          |
| `key`          | `string`                                 | The shell key the serve path resolved for a document it read (MISS or HIT), request partition included. Otherwise (no `ppr`, a partial request) the URL's key without a partition.  |
| `readEntry`    | `() => Promise<ShellCacheEntry \| null>` | Reads the document entry under `key` from the request's store (a passive `getShell`). A read: on a store with a shell memo it warms the memo, so call it after the reads you count. |
| `response`     | `Response`                               | Status and headers. Its body is already read.                                                                                                                                       |
| `body`         | `string`                                 | The body text.                                                                                                                                                                      |

### `resetShellTestState(): Promise<void>`

A worker keeps some PPR state across requests, and so does the test process across tests: the capture's stampede guard and backoff (a refused capture backs its URL off for later tests too), the capture's and the serve path's once-per-key warnings, the build-shell manifest memo, and `CFCacheStore`'s isolate memos (shells, tag markers, tag hints), which every `CFCacheStore` shares by namespace and URL — a later test's first request can be a HIT from an earlier test's shell. `resetShellTestState()` clears all of it. Call it in `beforeEach`, never while a request is in flight. `VercelCacheStore`'s memos live on the `cache` handle you pass it: a new handle per test starts empty.

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
expect(gold.key).toBe(shellCacheKey("/pricing", undefined, "tier:gold"));
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
  shellCacheKey("/plans", undefined, ["tier:gold", "v:a"]),
);
```

A partial request has no HTML step, so its `key` is the URL's key without a partition: read a partitioned route's entry from a document request's result.

## Handles and loader data

The result carries no structured `handles` map (unlike `renderHandler`): a handle value and loader data ride the payload, so you assert them as text in `prelude` and `flight`. A value the handler pushed is in the prelude and in every HIT's tail; a live loader's data is only in the tail. No public helper decodes a payload string into values: `normalizeFlight` and the `flightMatchers` (`toMatchFlight`) work on the text too.

```ts
// The handler pushed ctx.use(Meta)({ title: "Widget - Shop" })
expect(hit.prelude).toContain('"title":"Widget - Shop"');
expect(hit.flight).toContain('"title":"Widget - Shop"');
```

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
