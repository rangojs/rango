/**
 * Issue #964: a loader with its own cache() stores the tags its body
 * recorded, so a route cache() record and a PPR shell written over a
 * loader-cache HIT carry them (#957 links a consumed loader's tags onto the
 * record), and updateTag() of a body tag drops the loader entry, the record
 * and the shell together.
 *
 * Runs the real serve pipeline with real Flight (the #957 suite's harness,
 * shell-capture-record-tags.rsc-test.tsx); only the SSR half is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock("../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: async () => null }),
}));

import { renderToReadableStream } from "../../testing/vitest-stubs/plugin-rsc.js";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { cacheTag } from "../../cache/cache-tag.js";
import { createHandle } from "../../handle.js";
import { updateTag } from "../../cache/tag-invalidation.js";
import { buildRouterTrieFromUrlpatterns } from "../manifest-init.js";
import { handleRscRendering } from "../rsc-rendering.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { SegmentCacheStore } from "../../cache/types.js";
import { shellCacheKey } from "../../testing/shell-status.js";
import {
  createRequestContext,
  runWithRequestContext,
  setRequestContextParams,
  type ExecutionContext,
  type RequestContext,
} from "../../server/request-context.js";
import {
  classifyRequest,
  type ClassifyRequestDeps,
} from "../../router/request-classification.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload, SSRModule } from "../types.js";

const LAYOUT_TAG = "layout-tag";
const CONFIG_TAG = "cached-loader-cfg-tag";
const BODY_TAG = "cached-loader-body-tag";
const VALUE_TAG = "cached-loader-value-render-tag";
const HANDLE_TAG = "cached-loader-handle-render-tag";

const PRELUDE = "<html><body>FROZEN-PRELUDE</body></html>";

const ssrModule = {
  async renderHTML(rscStream: ReadableStream<Uint8Array>) {
    await new Response(rscStream).text();
    return new Response("<html><body>AXIS-1</body></html>").body!;
  },
  async resumeShellHTML(rscStream: ReadableStream<Uint8Array>) {
    return rscStream;
  },
  async captureShellHTML(
    rscStream: ReadableStream<Uint8Array>,
    options: { quiesce: Promise<unknown> },
  ) {
    const reader = rscStream.getReader();
    void (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    })();
    await options.quiesce;
    return { prelude: new TextEncoder().encode(PRELUDE), postponed: null };
  },
} as unknown as SSRModule;

type Router = ReturnType<typeof createRouter>;
type UseCtx = { use: (loader: unknown) => Promise<unknown> };

let bodyRuns = 0;

// Rendered when the loader's value or handle push is serialized: their tags
// only exist on a MISS, so the entry must store them.
async function RenderTagger({
  tag,
}: {
  tag: string;
}): Promise<React.ReactNode> {
  await Promise.resolve();
  cacheTag(tag);
  return <span>{tag}</span>;
}

const Crumbs = createHandle<React.ReactNode>(
  undefined,
  "test#LoaderCacheRecordTagsCrumbs",
);

const CachedLoader = (createLoader as Function)(
  async (ctx: { use: (handle: unknown) => (value: unknown) => void }) => {
    bodyRuns++;
    cacheTag(BODY_TAG);
    ctx.use(Crumbs)(<RenderTagger tag={HANDLE_TAG} />);
    return { run: bodyRuns, view: <RenderTagger tag={VALUE_TAG} /> };
  },
  undefined,
  "test#LoaderCacheRecordTags",
);

async function makeRouter(): Promise<Router> {
  const router = createRouter({} as any);
  router.routes(({ layout, cache, path, loader }: any) => [
    layout(
      async (ctx: UseCtx) => {
        cacheTag(LAYOUT_TAG);
        const value = (await ctx.use(CachedLoader)) as { run: number };
        return <main data-run={value.run}>layout</main>;
      },
      () => [
        loader(CachedLoader, () => [cache({ ttl: 600, tags: [CONFIG_TAG] })]),
        cache({ ttl: 60 }, () => [
          path("/c", () => <p>page</p>, {
            name: "loaderCacheRecordTags",
            ppr: { ttl: 300 },
          }),
        ]),
      ],
    ),
    // No loader cache() and no cache scope on its chain.
    path("/plain", () => <p>plain</p>, { name: "loaderCacheRecordTagsPlain" }),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
  return router;
}

function makeCtx(router: Router): HandlerContext<unknown> {
  return {
    version: "v-loader-cache-record-tags",
    router,
    callOnError: vi.fn(),
    renderToReadableStream: (payload: RscPayload, options?: object) =>
      renderToReadableStream(payload, options),
    loadSSRModule: async () => ssrModule,
    resolveStreamMode: async () => "stream",
  } as unknown as HandlerContext<unknown>;
}

const backgroundTasks: Promise<unknown>[] = [];
const executionContext = {
  waitUntil: (task: Promise<unknown>) => {
    backgroundTasks.push(task);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** Serve one document request and settle every background task it scheduled. */
let lastRequestContext: RequestContext<unknown> | undefined;

async function serve(
  router: Router,
  store: SegmentCacheStore,
  path: string,
): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const request = new Request(url, { headers: { accept: "text/html" } });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
    cacheStore: store,
    cacheProfiles: { default: { ttl: 300 } },
    executionContext,
  }) as RequestContext<unknown>;
  lastRequestContext = reqCtx;
  const ctx = makeCtx(router);
  // As rsc/handler.ts does: the cache keys carry the serving router.
  reqCtx._routerId = router.id;
  const response = await runWithRequestContext(reqCtx, async () => {
    const plan = await classifyRequest(request, url, {
      findMatch: (router as unknown as ClassifyRequestDeps).findMatch,
      routerVersion: ctx.version,
      routerId: router.id,
    });
    if (plan.mode !== "full-render") {
      throw new Error(`unexpected request plan ${plan.mode}`);
    }
    setRequestContextParams(plan.route.params, plan.route.routeKey);
    reqCtx._classifiedRoute = plan.route;
    return handleRscRendering(
      ctx,
      request,
      {},
      url,
      false,
      reqCtx._handleStore,
      undefined,
    );
  });
  await new Response(response.body).text();
  while (backgroundTasks.length > 0) {
    await Promise.allSettled(backgroundTasks.splice(0));
  }
  return response;
}

async function invalidate(store: SegmentCacheStore, tag: string) {
  const request = new Request("http://localhost/");
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
    cacheStore: store,
  });
  await runWithRequestContext(reqCtx, () => updateTag(tag));
}

const sortedTags = (tags: string[] | undefined): string[] =>
  [...(tags ?? [])].sort();

describe("route records and shells over a loader-cache HIT (#964)", () => {
  let router: Router;
  let store: MemorySegmentCacheStore;

  /** The router's shell key for /c. */
  const shellKey = (): string => shellCacheKey(router, "/c");
  /** The route records written so far: key and tags. */
  const records = () =>
    vi
      .mocked(store.set)
      .mock.calls.map(([key, data]) => ({ key, tags: sortedTags(data.tags) }));
  /** The tags the stored shell is invalidatable by (held beside the entry). */
  const shellTags = () =>
    sortedTags(
      (
        store as unknown as { shellCache: Map<string, { tags?: string[] }> }
      ).shellCache.get(shellKey())?.tags,
    );

  beforeEach(async () => {
    bodyRuns = 0;
    router = await makeRouter();
    store = new MemorySegmentCacheStore();
    vi.spyOn(store, "set");
    vi.spyOn(store, "setItem");
  });

  it("the loader entry stores its body's tags and those its value and handle push rendered", async () => {
    await serve(router, store, "/c");

    expect(bodyRuns).toBe(1);
    const writes = vi.mocked(store.setItem).mock.calls;
    expect(writes).toHaveLength(1);
    expect(sortedTags(writes[0]![2]?.tags)).toEqual(
      sortedTags([BODY_TAG, CONFIG_TAG, HANDLE_TAG, VALUE_TAG]),
    );
  });

  it("a record and a shell written over a loader HIT carry the body's tags", async () => {
    await serve(router, store, "/c");
    expect(records()).toHaveLength(1);
    expect(records()[0]!.tags).toEqual(
      expect.arrayContaining([LAYOUT_TAG, CONFIG_TAG, BODY_TAG]),
    );

    // Drop the record and the shell, not the loader entry.
    await invalidate(store, LAYOUT_TAG);
    vi.mocked(store.set).mockClear();
    await serve(router, store, "/c");

    expect(bodyRuns).toBe(1);
    const written = [LAYOUT_TAG, CONFIG_TAG, BODY_TAG, VALUE_TAG];
    expect(records()).toHaveLength(1);
    expect(records()[0]!.tags).toEqual(expect.arrayContaining(written));
    expect(shellTags()).toEqual(expect.arrayContaining(written));
  });

  it("updateTag() of a body tag drops the shell, the record and the loader entry", async () => {
    await serve(router, store, "/c");
    await invalidate(store, LAYOUT_TAG);
    await serve(router, store, "/c");
    const recordKey = records().at(-1)!.key;
    expect(bodyRuns).toBe(1);
    expect(await store.getShell(shellKey())).not.toBeNull();
    expect(await store.get(recordKey)).not.toBeNull();

    await invalidate(store, BODY_TAG);

    expect(await store.getShell(shellKey())).toBeNull();
    expect(await store.get(recordKey)).toBeNull();
    const again = await serve(router, store, "/c");
    expect(again.headers.get("x-rango-shell")).toBe("MISS");
    // The loader entry went with them: its body ran again.
    expect(bodyRuns).toBe(2);
  });

  it("the match arms the per-execution loader tag sets only for a route that binds a loader cache()", async () => {
    await serve(router, store, "/plain");
    expect(lastRequestContext?._recordLoaderTags).toBeUndefined();
    expect(lastRequestContext?._recordTagOwners).toBeUndefined();

    await serve(router, store, "/c");
    expect(lastRequestContext?._recordLoaderTags).toBe(true);
  });
});
