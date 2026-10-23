/**
 * Derived render pass cost: building a shell capture and a background
 * re-render context, and a shell MISS (foreground render plus capture) and a
 * HIT (prelude plus PPR tail) served through serveShellRequest over a fixed
 * route set. Each pass keeps V8 fast properties (context-fast-properties.test.ts).
 * It reaches the passes only through deriveShellCaptureContext,
 * rerenderAndCacheRoute and serveShellRequest, so it also runs on a checkout
 * without server/render-pass.ts.
 *
 *   ./node_modules/.bin/vitest bench --run --config vitest.rsc.config.ts src/server/__tests__/render-pass.bench.tsx
 */
import { bench, describe, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
} from "../../testing/flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { makeRequestContext } from "../../__tests__/kit/request-context.js";
import { createHandleStore, type HandleStore } from "../handle-store.js";
import { getContext } from "../context.js";
import { deriveShellCaptureContext } from "../../rsc/shell-capture.js";
import { rerenderAndCacheRoute } from "../../router/match-middleware/background-revalidation.js";
import type { MatchContext } from "../../router/match-context.js";
import type { RouterContext } from "../../router/router-context.js";
import type { CacheScope } from "../../cache/cache-scope.js";
import { resolveThemeConfig } from "../../theme/constants.js";

const Crumbs = createHandle<string>();
const Baked = createLoader(async () => ({ baked: "baked" }));
const Live = createLoader(async () => ({ live: "live" }));
const LiveB = createLoader(async () => ({ liveB: "liveB" }));

function Page(): React.ReactNode {
  return <p>page</p>;
}

/** A bare PPR page, one with an ssr: false loader and a handle push, one under a layout. */
const ROUTES = ["/a", "/b", "/c/1"] as const;

const router = createRouter({}).routes(
  urls(({ path, layout, loader, loading }) => [
    path("/a", Page, { name: "a", ppr: true }, () => [
      loader(Live),
      loading(<i>a</i>),
    ]),
    path(
      "/b",
      (ctx) => {
        ctx.use(Crumbs)("b");
        return <p>b</p>;
      },
      { name: "b", ppr: true },
      () => [loader(Baked, { ssr: false }), loader(Live), loading(<i>b</i>)],
    ),
    layout(
      ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
      () => [
        path("/c/:id", Page, { name: "c", ppr: true }, () => [
          loader(LiveB),
          loader(Baked, { ssr: false }),
          loading(<i>c</i>),
        ]),
      ],
    ),
  ]),
);

const base = makeRequestContext({
  url: "https://example.com/p",
  cacheStore: new MemorySegmentCacheStore(),
  themeConfig: resolveThemeConfig(true),
});
const otherRequest = new Request("https://example.com/other?x=1");
const otherUrl = new URL(otherRequest.url);

const handleStore = createHandleStore();
const routerCtx = {
  createHandleStore: (): HandleStore => handleStore,
  createHandlerContext: () => ({}),
  setupLoaderAccess: () => {},
  resolveAllSegments: async () => [],
} as unknown as RouterContext;
const match = {
  env: {},
  request: base.request,
  url: base.url,
  pathname: "/p",
  matched: { params: {}, routeKey: "r" },
  routeMap: {},
  entries: [],
  routeKey: "r",
  Store: getContext().getOrCreateStore("r"),
  interceptResult: null,
  isIntercept: false,
} as unknown as MatchContext;
const cacheScope = { cacheRoute: async () => {} } as unknown as CacheScope;

let sink: unknown;
let next = 0;
const nextUrl = (): (typeof ROUTES)[number] => ROUTES[next++ % ROUTES.length]!;
const hitStores = new Map<string, MemorySegmentCacheStore>();

async function primeHitStores(): Promise<void> {
  await resetShellTestState();
  for (const url of ROUTES) {
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(router, url, { cacheStore });
    const hit = await serveShellRequest(router, url, { cacheStore });
    if (hit.shellStatus !== "HIT") {
      throw new Error(`${url}: expected a HIT, got ${hit.shellStatus}`);
    }
    hitStores.set(url, cacheStore);
  }
}

describe("derived render pass", () => {
  bench("shell capture context", () => {
    sink = deriveShellCaptureContext(base, { ttl: 60, swr: 300 });
  });

  bench("shell capture context, navigation-only", () => {
    sink = deriveShellCaptureContext(
      base,
      { ttl: 60, swr: 300 },
      { request: otherRequest, url: otherUrl },
    );
  });

  bench("background re-render (stub resolution)", async () => {
    sink = await rerenderAndCacheRoute(match, base, cacheScope, routerCtx);
  });
});

describe("through serveShellRequest", () => {
  bench(
    "MISS + shell capture",
    async () => {
      const url = nextUrl();
      const miss = await serveShellRequest(router, url, {
        cacheStore: new MemorySegmentCacheStore(),
      });
      if (miss.shellStatus !== "MISS") {
        throw new Error(`${url}: expected a MISS, got ${miss.shellStatus}`);
      }
      sink = miss;
    },
    { time: 3000, setup: resetShellTestState },
  );

  bench(
    "HIT + PPR tail",
    async () => {
      const url = nextUrl();
      const hit = await serveShellRequest(router, url, {
        cacheStore: hitStores.get(url)!,
      });
      if (hit.shellStatus !== "HIT") {
        throw new Error(`${url}: expected a HIT, got ${hit.shellStatus}`);
      }
      sink = hit;
    },
    { time: 3000, setup: primeHitStores },
  );
});

void sink;
