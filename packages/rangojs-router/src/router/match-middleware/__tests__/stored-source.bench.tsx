/**
 * Stored-segment serve cost (cache-lookup.ts): a segment-cache HIT and a
 * prerender build HIT, each as a document and as a navigation that keeps the
 * client's segments. First through withCacheLookup alone, with real Flight
 * segments decoded per request and stub loaders, then through
 * serveShellRequest, the router's production request handler. It reaches the
 * serve path only through withCacheLookup, setPrerenderStoreForTests and
 * serveShellRequest.
 *
 * Runs in the rsc project (react-server condition, production React):
 *
 *   ./node_modules/.bin/vitest bench --run --config vitest.rsc.config.ts src/router/match-middleware/__tests__/stored-source.bench.tsx
 *
 * To compare two revisions, run it in both checkouts alternately, several
 * times each, on a quiet machine.
 */
import { afterAll, bench, describe, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);

import { setPrerenderStoreForTests, withCacheLookup } from "../cache-lookup.js";
import { runWithRouterContext } from "../../router-context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import {
  deserializeSegments,
  serializeSegments,
} from "../../../cache/segment-codec.js";
import { encodeHandles } from "../../../cache/handle-snapshot.js";
import type { SerializedSegmentData } from "../../../cache/types.js";
import type { EntryData } from "../../../server/context.js";
import type { ResolvedSegment } from "../../../types.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
} from "../../../testing/flight.entry.js";
import {
  createLoader,
  createRouter,
  Prerender,
  urls,
  type BuildContext,
} from "../../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../../cache/index.js";

let sink: unknown;

/** A root layout, a nested layout and the route, as the record stores them. */
function storedSegments(): ResolvedSegment[] {
  const base = { params: {}, index: 0, belongsToRoute: false };
  return [
    {
      ...base,
      id: "M0L0",
      namespace: "M0L0",
      type: "layout",
      component: <html>{null}</html>,
    },
    {
      ...base,
      id: "M0L0L1",
      namespace: "M0L0L1",
      type: "layout",
      component: (
        <main>
          <nav>shell</nav>
        </main>
      ),
    },
    {
      ...base,
      id: "M0L0L1R2",
      namespace: "M0L0L1R2",
      type: "route",
      belongsToRoute: true,
      component: (
        <article>
          <h1>item 1</h1>
          <p>body</p>
        </article>
      ),
    },
  ] as ResolvedSegment[];
}

const ENTRIES = [
  {
    id: "route",
    shortCode: "M0L0L1R2",
    type: "route",
    layout: [],
    parallel: {},
    loader: [],
  },
] as unknown as EntryData[];

let serialized: SerializedSegmentData[];
let handles: string;

async function prepare(): Promise<void> {
  serialized = await serializeSegments(storedSegments());
  handles = await encodeHandles({ M0L0L1R2: { title: ["item 1"] } });
  setPrerenderStoreForTests({
    get: async () => ({ segments: serialized, handles }),
  });
}

afterAll(() => {
  setPrerenderStoreForTests(undefined);
});

const routerCtx = {
  evaluateRevalidation: async () => false,
  buildEntryRevalidateMap: () => new Map(),
  resolveLoadersOnlyWithRevalidation: async () => ({
    segments: [],
    matchedIds: [],
  }),
  resolveAllSegmentsWithRevalidation: async () => ({
    segments: [],
    matchedIds: [],
  }),
};

/** A segment-cache scope whose record decodes per request, as a store read does. */
const cacheScope = {
  enabled: true,
  lookupRouteDetailed: async () => ({
    status: "hit",
    result: {
      segments: await deserializeSegments(serialized),
      shouldRevalidate: false,
    },
  }),
};

/** One request through withCacheLookup, drained. */
async function lookup(
  source: "segment cache" | "prerender build",
  navigation: boolean,
): Promise<void> {
  const url = new URL("http://localhost/item/1");
  const request = new Request(url);
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
  });
  const ctx = {
    cacheScope: source === "segment cache" ? cacheScope : undefined,
    isAction: false,
    isIntercept: false,
    isFullMatch: !navigation,
    request,
    pathname: url.pathname,
    url,
    prevUrl: navigation ? new URL("http://localhost/other") : url,
    prevParams: {},
    clientSegmentSet: new Set(
      navigation ? storedSegments().map((s) => s.id) : [],
    ),
    entries: ENTRIES,
    matched: {
      params: {},
      routeKey: "item",
      ...(source === "prerender build" ? { pr: true } : {}),
    },
    routeKey: "item",
    metricsStore: undefined,
    stale: false,
    handlerContext: {},
    Store: { run: (fn: () => unknown) => fn() },
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
  } as unknown as MatchPipelineState;
  await runWithRouterContext(routerCtx as any, () =>
    runWithRequestContext(reqCtx, async () => {
      for await (const segment of withCacheLookup(ctx, state)(empty())) {
        sink = segment;
      }
    }),
  );
  if (!state.cacheHit) throw new Error(`${source}: expected a HIT`);
}

async function* empty(): AsyncGenerator<ResolvedSegment> {}

describe("withCacheLookup", () => {
  for (const source of ["segment cache", "prerender build"] as const) {
    bench(`${source} HIT, document`, () => lookup(source, false), {
      time: 2000,
      setup: prepare,
    });
    bench(`${source} HIT, navigation`, () => lookup(source, true), {
      time: 2000,
      setup: prepare,
    });
  }
});

const StockLoader = createLoader(async () => ({ stock: 3 }));

/** Page handler runs: a HIT serves without one. */
let pageRuns = 0;

function page(params: { id: string }): React.ReactNode {
  pageRuns += 1;
  return <h1>{`item ${params.id}`}</h1>;
}

/** The stored-source.rsc-test.tsx tree: a layout around /item/:id with a loader. */
function makeRouter(source: "segment cache" | "prerender build") {
  const handler =
    source === "segment cache"
      ? (ctx: { params: { id: string } }) => page(ctx.params)
      : Prerender<{ id: string }>(
          async () => [{ id: "1" }],
          (ctx: BuildContext<{ id: string }>) => page(ctx.params),
        );
  return createRouter({}).routes(
    urls(({ layout, path, loader, cache }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/item/:id", handler, { name: "item" }, () => [
            loader(StockLoader),
            ...(source === "segment cache" ? [cache({ ttl: 300 })] : []),
          ]),
        ],
      ),
    ]),
  );
}

const routers = {
  "segment cache": makeRouter("segment cache"),
  "prerender build": makeRouter("prerender build"),
};
const cacheStores = new Map<string, MemorySegmentCacheStore>();

/** Write each source's entry the way production fills it, then check a HIT. */
async function prime(): Promise<void> {
  await resetShellTestState();
  for (const source of ["segment cache", "prerender build"] as const) {
    for (const navigation of [false, true]) {
      const cacheStore = new MemorySegmentCacheStore();
      cacheStores.set(`${source}:${navigation}`, cacheStore);
      await serveShellRequest(routers[source], "/item/1", {
        cacheStore,
        ...(navigation ? { partial: { from: "/" } } : {}),
      });
      const runs = pageRuns;
      await serve(source, navigation);
      if (pageRuns !== runs) throw new Error(`${source}: not a HIT`);
    }
  }
}

async function serve(
  source: "segment cache" | "prerender build",
  navigation: boolean,
): Promise<void> {
  const options: ServeShellRequestOptions = {
    cacheStore: cacheStores.get(`${source}:${navigation}`)!,
    ...(navigation ? { partial: { from: "/" } } : {}),
  };
  const result = await serveShellRequest(routers[source], "/item/1", options);
  if (result.response.status !== 200) {
    throw new Error(`${source}: ${result.response.status}`);
  }
  sink = result.body;
}

describe("through serveShellRequest", () => {
  for (const source of ["segment cache", "prerender build"] as const) {
    bench(`${source} HIT, document`, () => serve(source, false), {
      time: 3000,
      setup: prime,
    });
    bench(`${source} HIT, navigation`, () => serve(source, true), {
      time: 3000,
      setup: prime,
    });
  }
});

void sink;
