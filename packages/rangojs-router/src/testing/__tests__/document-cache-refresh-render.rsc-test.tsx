/**
 * A stale document cache HIT re-runs the page in the background (SWR), and
 * the refreshed entry is the page a MISS of the same request renders. The
 * stale HIT itself rendered nothing, so the re-run matches, renders and
 * resolves its own render barrier: a loader that reads a handle after
 * `rendered()` sees the handles the streamed handler pushed, a loader read
 * through `getRequestContext().use()` sees the route's params, and a
 * `dynamic()`, the re-run's own or one middleware ahead of the cache called,
 * opts the re-run's render out of the PPR shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  getRequestContext,
  urls,
  type HandlerContext,
  type MiddlewareFn,
} from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";

const CACHE_CONTROL = "s-maxage=1, stale-while-revalidate=60";
let runs = 0;

const optIn: MiddlewareFn = async (ctx, next) => {
  ctx.header("Cache-Control", CACHE_CONTROL);
  return next();
};

// A streaming route: its loader reads a handle the handler pushes late.
const Stamp = createHandle<string>();
const StampReader = createLoader(async (ctx) => {
  await ctx.rendered();
  return `read:[${ctx.get(Stamp).join(",")}]`;
});
async function StreamingPage(ctx: HandlerContext): Promise<React.ReactNode> {
  const run = ++runs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  ctx.use(Stamp)(`stamp-${run}`);
  return <p>{`page-${run}`}</p>;
}

// A loader read through the request context, not the handler's ctx.
const ParamLoader = createLoader(
  async (ctx) => `id:${(ctx.params as { id?: string }).id}`,
);
async function ParamPage(): Promise<React.ReactNode> {
  const run = ++runs;
  return <p>{`page-${run} ${await getRequestContext().use(ParamLoader)}`}</p>;
}

// Loaders read after the barrier resolved: one that called rendered()
// before, one that calls it after. A read once the guard closed forms no
// deadlock, on a MISS or in the re-run.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RenderedEarly = createLoader(async (ctx) => {
  await ctx.rendered();
  return "rendered-early";
});
const RenderedLate = createLoader(async (ctx) => {
  await sleep(10);
  await ctx.rendered();
  return "rendered-late";
});
async function LateRead({
  ctx,
  loader,
}: {
  ctx: HandlerContext;
  loader: typeof RenderedEarly;
}): Promise<React.ReactNode> {
  return <i>{`read:${await ctx.use(loader)}`}</i>;
}
function LateReadPage(ctx: HandlerContext): React.ReactNode {
  const run = ++runs;
  const loader = ctx.pathname === "/late-early" ? RenderedEarly : RenderedLate;
  return (
    <p>
      {`page-${run} `}
      <LateRead ctx={ctx} loader={loader} />
    </p>
  );
}

// A ppr route whose route middleware opts the request out, and one that
// middleware ahead of the cache opts out.
const optOut: MiddlewareFn = async (ctx, next) => {
  ctx.dynamic();
  return next();
};
const optOutAhead: MiddlewareFn = async (ctx, next) => {
  if (ctx.url.pathname === "/ppr-ahead") ctx.dynamic();
  return next();
};
function PprPage(): React.ReactNode {
  return <p>{`page-${++runs}`}</p>;
}

const router = createRouter()
  .use(optIn)
  .use(optOutAhead)
  .use(createDocumentCacheMiddleware())
  .routes(
    urls(({ path, loader, loading, middleware }) => [
      path("/streaming", StreamingPage, { name: "streaming" }, () => [
        loader(StampReader),
        loading(<p>loading</p>),
      ]),
      path("/p/:id", ParamPage, { name: "param" }),
      path("/late-early", LateReadPage, { name: "lateEarly" }, () => [
        loader(RenderedEarly),
      ]),
      path("/late-late", LateReadPage, { name: "lateLate" }, () => [
        loader(RenderedLate),
      ]),
      path("/ppr", PprPage, { name: "ppr", ppr: true }, () => [
        middleware(optOut),
      ]),
      path("/ppr-ahead", PprPage, { name: "pprAhead", ppr: true }),
    ]),
  );

/** What a test compares: the cache status, the shell status and the page. */
function seen(result: ServeShellRequestResult, read: RegExp) {
  return {
    doc: result.response.headers.get("x-document-cache-status"),
    shell: result.response.headers.get("x-rango-shell"),
    page: read.global
      ? result.body.match(read)?.join(" ")
      : result.body.match(read)?.[0],
  };
}

/**
 * Serve `url` once (a MISS), then `refreshes` times past the entry's
 * s-maxage (each a stale HIT whose re-run refreshes the entry), each
 * followed by a request that reads the refreshed entry.
 */
async function missThenRefreshes(
  url: string,
  read: RegExp,
  refreshes = 1,
): Promise<Array<ReturnType<typeof seen>>> {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const cacheStore = new MemorySegmentCacheStore();
  const served = [
    seen(await serveShellRequest(router, url, { cacheStore }), read),
  ];
  for (let i = 0; i < refreshes; i++) {
    // Past the s-maxage=1, within the 60 s swr.
    offset += 2_100;
    served.push(
      seen(await serveShellRequest(router, url, { cacheStore }), read),
    );
    served.push(
      seen(await serveShellRequest(router, url, { cacheStore }), read),
    );
  }
  return served;
}

beforeEach(async () => {
  await resetShellTestState();
  runs = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a stale document cache entry's background re-run", () => {
  it("resolves its own render barrier: a loader reads the handles the streamed handler pushed", async () => {
    const served = await missThenRefreshes("/streaming", /read:\[[^\]]*\]/);
    expect(served).toEqual([
      { doc: "MISS", shell: null, page: "read:[stamp-1]" },
      { doc: "STALE", shell: null, page: "read:[stamp-1]" },
      { doc: "HIT", shell: null, page: "read:[stamp-2]" },
    ]);
  });

  it("reads getRequestContext().use() loaders with the route's params", async () => {
    const served = await missThenRefreshes("/p/7", /page-\d id:\w+/);
    expect(served).toEqual([
      { doc: "MISS", shell: null, page: "page-1 id:7" },
      { doc: "STALE", shell: null, page: "page-1 id:7" },
      { doc: "HIT", shell: null, page: "page-2 id:7" },
    ]);
  });

  it("reads, after its barrier resolved, a loader that called rendered() before", async () => {
    const served = await missThenRefreshes(
      "/late-early",
      /page-\d|read:rendered-\w+/g,
    );
    expect(served).toEqual([
      { doc: "MISS", shell: null, page: "page-1 read:rendered-early" },
      { doc: "STALE", shell: null, page: "page-1 read:rendered-early" },
      { doc: "HIT", shell: null, page: "page-2 read:rendered-early" },
    ]);
  });

  it("reads, after its barrier resolved, a loader that calls rendered() after", async () => {
    const served = await missThenRefreshes(
      "/late-late",
      /page-\d|read:rendered-\w+/g,
    );
    expect(served).toEqual([
      { doc: "MISS", shell: null, page: "page-1 read:rendered-late" },
      { doc: "STALE", shell: null, page: "page-1 read:rendered-late" },
      { doc: "HIT", shell: null, page: "page-2 read:rendered-late" },
    ]);
  });

  it("renders live when the route opts out with dynamic(), as a MISS does", async () => {
    const served = await missThenRefreshes("/ppr", /page-\d/, 2);
    expect(served).toEqual([
      { doc: "MISS", shell: null, page: "page-1" },
      { doc: "STALE", shell: null, page: "page-1" },
      { doc: "HIT", shell: null, page: "page-2" },
      { doc: "STALE", shell: null, page: "page-2" },
      { doc: "HIT", shell: null, page: "page-3" },
    ]);
  });

  it("starts from a dynamic() that middleware ahead of the cache called, as a MISS does", async () => {
    const served = await missThenRefreshes("/ppr-ahead", /page-\d/, 2);
    expect(served).toEqual([
      { doc: "MISS", shell: null, page: "page-1" },
      { doc: "STALE", shell: null, page: "page-1" },
      { doc: "HIT", shell: null, page: "page-2" },
      { doc: "STALE", shell: null, page: "page-2" },
      { doc: "HIT", shell: null, page: "page-3" },
    ]);
  });
});
