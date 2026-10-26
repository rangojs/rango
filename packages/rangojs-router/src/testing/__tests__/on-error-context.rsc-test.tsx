/**
 * What `onError` is told about an error, through serveShellRequest:
 *
 * - `background: true` for an error from work whose output goes to a cache,
 *   never to the response of the request that started it: a stale cache()
 *   record's refresh, a navigation MISS's proactive write, a PPR shell
 *   recapture, a stale document's re-run, a stale "use cache" function's or
 *   cached loader's refresh. `handledByBoundary` is `false` there: the failed
 *   render is never stored, so no visitor sees the fallback. Both used to
 *   report like the visitor's own error, `handledByBoundary: true`.
 * - `env` on an error the segment walk catches: it was unset.
 * - `duration` on every error: it was never set.
 * - An intercept handler's error names its slot (`parallel`), not the entry
 *   that declares it (`layout`).
 * - `isPartial` on a streamed (loading()) handler's rejection: it was unset
 *   on a navigation.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import {
  createLoader,
  createRouter,
  urls,
  type Middleware,
  type OnErrorContext,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  VercelCacheStore,
  createDocumentCacheMiddleware,
  type VercelRuntimeCache,
} from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import {
  getStamp,
  state as useCacheState,
} from "./fixtures/on-error-context-data.js";

function vercelCache(): VercelRuntimeCache {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag() {},
  };
}

/** Date.now moves; timers stay real, so a stale entry needs no sleeping. */
function movableClock(): { advance(ms: number): void } {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  return { advance: (ms) => (offset += ms) };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

let failing = false;
let layoutThrows = false;
let interceptThrows = false;
const reports: OnErrorContext[] = [];
const onError = (ctx: OnErrorContext): void => {
  reports.push(ctx);
};

/** Each report's phase, background marker and boundary flag, in order. */
function marks(): Pick<
  OnErrorContext,
  "phase" | "background" | "handledByBoundary"
>[] {
  return reports.map((r) => ({
    phase: r.phase,
    background: r.background,
    handledByBoundary: r.handledByBoundary,
  }));
}

const FOREGROUND = {
  phase: "handler",
  background: undefined,
  handledByBoundary: true,
} as const;
const BACKGROUND = {
  phase: "handler",
  background: true,
  handledByBoundary: false,
} as const;
/** A refresh's or capture's own failure, reported inside it. */
const BACKGROUND_TASK = {
  phase: "cache",
  background: true,
  handledByBoundary: false,
} as const;

function Page(): React.ReactNode {
  if (failing) throw new Error("page down");
  return <p>page-ok</p>;
}

function Layout(): React.ReactNode {
  if (layoutThrows) throw new Error("layout down");
  return <main>shell</main>;
}

function Modal(): React.ReactNode {
  if (interceptThrows) throw new Error("intercept down");
  return <dialog>modal-body</dialog>;
}

async function Streamed(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  if (failing) throw new Error("streamed down");
  return <p>streamed-ok</p>;
}

const FlakyLoader = createLoader(async () => {
  if (failing) throw new Error("loader down");
  return { stamp: "loader-ok" };
});

function WithLoader(): React.ReactNode {
  return <p>with-loader</p>;
}

const Declared = <p>declared-error</p>;

async function FailingChild(): Promise<React.ReactNode> {
  if (failing) throw new Error("child down");
  return <i>child-ok</i>;
}

/** A healthy handler whose async server component fails in Flight. */
function WithFailingChild(): React.ReactNode {
  return (
    <section>
      <FailingChild />
    </section>
  );
}

/** One rejection both an uncached layout and a cache() record await. */
const shared: { value: Promise<string> } = { value: Promise.resolve("ok") };
const SHARED_ERROR = new Error("shared down");

async function SharedReader(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 20));
  return <i>{await shared.value}</i>;
}

function SharedOuterLayout(): React.ReactNode {
  return (
    <div>
      <React.Suspense fallback={<b>wait</b>}>
        <SharedReader />
      </React.Suspense>
    </div>
  );
}

async function CachedSharedLayout(): Promise<React.ReactNode> {
  await shared.value;
  return <section>cached</section>;
}

const staleDocument: Middleware = async (ctx, next) => {
  ctx.header("Cache-Control", "s-maxage=1, stale-while-revalidate=300");
  await next();
};

beforeEach(async () => {
  await resetShellTestState();
  failing = false;
  layoutThrows = false;
  interceptThrows = false;
  useCacheState.failing = false;
  shared.value = Promise.resolve("ok");
  reports.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("background: an error whose render goes to a cache", () => {
  const router = createRouter({
    onError,
    cacheProfiles: { short: { ttl: 1, swr: 300 } },
  })
    .use(createDocumentCacheMiddleware())
    .use("/doc", staleDocument)
    .routes(
      urls(
        ({
          path,
          cache,
          layout,
          loader,
          loading,
          intercept,
          errorBoundary,
        }) => [
          cache({ ttl: 0, swr: 60 }, () => [
            path("/st", Streamed, { name: "st" }, () => [
              loading(<p>loading</p>),
              errorBoundary(Declared),
            ]),
            path("/rc", WithFailingChild, { name: "rc" }),
          ]),
          layout(SharedOuterLayout, () => [
            errorBoundary(Declared),
            cache({ ttl: 0, swr: 60 }, () => [
              layout(CachedSharedLayout, () => [
                path("/sh", () => <p>sh</p>, { name: "sh" }),
              ]),
            ]),
          ]),
          cache({ ttl: 0, swr: 60 }, () => [
            layout(Layout, () => [
              path("/s", Page, { name: "s" }, () => [errorBoundary(Declared)]),
              path("/list", () => <ul>list</ul>, { name: "list" }),
              path("/item/:id", () => <article>item</article>, {
                name: "item",
              }),
              path("/photo/:id", () => <figure>photo</figure>, {
                name: "photo",
              }),
              intercept("@modal", ".photo", Modal),
            ]),
          ]),
          path("/p", Page, { name: "p", ppr: { ttl: 1, swr: 300 } }, () => [
            errorBoundary(Declared),
          ]),
          path("/doc", Page, { name: "doc" }, () => [errorBoundary(Declared)]),
          path(
            "/uc",
            async () => <p>{await getStamp()}</p>,
            { name: "uc" },
            () => [errorBoundary(Declared)],
          ),
          path("/lc", WithLoader, { name: "lc" }, () => [
            errorBoundary(Declared),
            loader(FlakyLoader, () => [cache({ ttl: 1, swr: 300 })]),
          ]),
          path(
            "/pl",
            WithLoader,
            { name: "pl", ppr: { ttl: 60, swr: 300 } },
            () => [errorBoundary(Declared), loader(FlakyLoader)],
          ),
        ],
      ),
    );

  describe("a cache() record", () => {
    let cacheStore: VercelCacheStore;
    beforeEach(() => {
      cacheStore = new VercelCacheStore({ cache: vercelCache() });
    });

    /** The ids a client on /list holds, from a navigation that renders it. */
    async function listSegments(): Promise<string[]> {
      const list = await serveShellRequest(router, "/list", {
        cacheStore,
        partial: true,
      });
      const { metadata } = await deserializeResult<{
        metadata: { matched: string[] };
      }>(list.flight!);
      return metadata.matched;
    }

    it("the visitor's own error reports it unset, handled by its boundary (unchanged)", async () => {
      failing = true;
      await serveShellRequest(router, "/s", { cacheStore });
      expect(marks()).toStrictEqual([FOREGROUND]);
    });

    it("a stale record's refresh reports it true, not handled, with the starting request", async () => {
      const clock = movableClock();
      await serveShellRequest(router, "/s", { cacheStore });
      clock.advance(1_100);
      failing = true;
      const stale = await serveShellRequest(router, "/s", { cacheStore });
      expect(stale.flight).toContain("page-ok");
      expect(marks()).toStrictEqual([BACKGROUND]);
      expect(reports[0]!.url.pathname).toBe("/s");
    });

    it("a navigation MISS's proactive write reports it true", async () => {
      const segments = await listSegments();
      layoutThrows = true;
      // The client holds the layout: only the proactive re-render runs it.
      await serveShellRequest(router, "/item/1", {
        cacheStore,
        partial: { from: "/list", segments },
      });
      expect(marks()).toStrictEqual([BACKGROUND]);
    });

    it("an intercept handler's error in a stale record's refresh reports it true", async () => {
      const clock = movableClock();
      const segments = await listSegments();
      const open = () =>
        serveShellRequest(router, "/photo/1", {
          cacheStore,
          partial: { from: "/list", segments },
        });
      await open();
      clock.advance(1_100);
      interceptThrows = true;
      const stale = await open();
      expect(stale.flight).toContain("modal-body");
      expect(marks()).toStrictEqual([BACKGROUND]);
    });

    it("a streamed handler's rejection in a refresh a navigation started reports it true, with isPartial", async () => {
      const clock = movableClock();
      await serveShellRequest(router, "/st", { cacheStore, partial: true });
      clock.advance(1_100);
      failing = true;
      await serveShellRequest(router, "/st", { cacheStore, partial: true });
      await settle();
      expect(
        reports.map((r) => ({
          phase: r.phase,
          background: r.background,
          handledByBoundary: r.handledByBoundary,
          isPartial: r.isPartial,
        })),
      ).toStrictEqual([{ ...BACKGROUND, isPartial: true }]);
    });

    it("a server component's Flight error in a refresh reports the refused write true", async () => {
      const clock = movableClock();
      await serveShellRequest(router, "/rc", { cacheStore });
      clock.advance(1_100);
      failing = true;
      const stale = await serveShellRequest(router, "/rc", { cacheStore });
      await settle();
      expect(stale.flight).toContain("child-ok");
      // cacheRoute refuses the write and reports it (cache-write), inside the
      // refresh.
      expect(marks()).toStrictEqual([BACKGROUND_TASK]);
      expect(reports[0]!.metadata?.category).toBe("cache-write");
    });

    it("an error both the visitor's render and a refresh reach is reported by each", async () => {
      const clock = movableClock();
      await serveShellRequest(router, "/sh", { cacheStore });
      clock.advance(1_100);
      shared.value = Promise.reject(SHARED_ERROR);
      shared.value.catch(() => {});
      await serveShellRequest(router, "/sh", { cacheStore });
      await settle();
      // The visitor's Suspense child and the refresh's cached layout: neither
      // report takes the place of the other.
      expect(
        reports
          .filter((r) => r.error === SHARED_ERROR)
          .map((r) => r.background),
      ).toStrictEqual(expect.arrayContaining([true, undefined]));
    });
  });

  describe("another cache", () => {
    let cacheStore: MemorySegmentCacheStore;
    beforeEach(() => {
      cacheStore = new MemorySegmentCacheStore();
    });

    it("a PPR HIT's live loader error reports it unset: the tail is the visitor's", async () => {
      await serveShellRequest(router, "/pl", { cacheStore });
      await settle();
      failing = true;
      const hit = await serveShellRequest(router, "/pl", { cacheStore });
      await settle();
      expect(hit.shellStatus).toBe("HIT");
      expect(reports.map((r) => [r.phase, r.background])).toStrictEqual([
        ["loader", undefined],
      ]);
    });

    it("a PPR shell's recapture reports it true, and the refused capture", async () => {
      const clock = movableClock();
      await serveShellRequest(router, "/p", { cacheStore });
      await settle();
      clock.advance(1_500);
      failing = true;
      const stale = await serveShellRequest(router, "/p", { cacheStore });
      await settle();
      expect(stale.shellStatus).toBe("HIT");
      expect(marks()).toStrictEqual([BACKGROUND, BACKGROUND_TASK]);
    });

    it("a stale document's re-run reports it true", async () => {
      const clock = movableClock();
      await serveShellRequest(router, "/doc", { cacheStore });
      await settle();
      clock.advance(1_500);
      failing = true;
      const stale = await serveShellRequest(router, "/doc", { cacheStore });
      await settle();
      expect(stale.response.headers.get("x-document-cache-status")).toBe(
        "STALE",
      );
      // A 500 is not stored: the re-run ends without a write to refuse.
      expect(marks()).toStrictEqual([BACKGROUND]);
    });

    it('a stale "use cache" function\'s refresh reports it true', async () => {
      const clock = movableClock();
      await serveShellRequest(router, "/uc", { cacheStore });
      await settle();
      clock.advance(1_500);
      useCacheState.failing = true;
      const stale = await serveShellRequest(router, "/uc", { cacheStore });
      await settle();
      expect(stale.flight).toContain("stamp-ok");
      expect(marks()).toStrictEqual([BACKGROUND_TASK]);
      expect(reports[0]!.metadata?.category).toBe("stale-revalidation");
    });

    it("a stale cached loader's refresh reports it true", async () => {
      const clock = movableClock();
      await serveShellRequest(router, "/lc", { cacheStore });
      await settle();
      clock.advance(1_500);
      failing = true;
      const stale = await serveShellRequest(router, "/lc", { cacheStore });
      await settle();
      expect(stale.flight).toContain("loader-ok");
      expect(marks()).toStrictEqual([BACKGROUND_TASK]);
      expect(reports[0]!.metadata?.category).toBe("stale-revalidation");
    });
  });
});

describe("env and duration", () => {
  type Env = { tenant: string };
  const router = createRouter<Env>({ onError }).routes(
    urls(({ path, loader, errorBoundary }) => [
      path("/h", Page, { name: "h" }, () => [errorBoundary(Declared)]),
      path("/l", WithLoader, { name: "l" }, () => [
        errorBoundary(Declared),
        loader(FlakyLoader),
      ]),
    ]),
  );
  const env: Env = { tenant: "t1" };

  it.each([
    ["a document", undefined],
    ["a navigation", true as const],
  ])(
    "a handler error the walk catches on %s carries env and duration",
    async (_, partial) => {
      failing = true;
      await serveShellRequest(router, "/h", { env, partial });
      expect(reports).toHaveLength(1);
      expect(reports[0]!.env).toStrictEqual(env);
      expect(reports[0]!.duration).toBeGreaterThanOrEqual(0);
    },
  );

  it("a loader error carries duration", async () => {
    failing = true;
    await serveShellRequest(router, "/l", { env, partial: true });
    expect(reports.map((r) => r.phase)).toStrictEqual(["loader"]);
    expect(reports[0]!.env).toStrictEqual(env);
    expect(reports[0]!.duration).toBeGreaterThanOrEqual(0);
  });
});

describe("an intercept handler's error", () => {
  const router = createRouter({ onError }).routes(
    urls(({ path, layout, intercept, errorBoundary }) => [
      layout(Layout, () => [
        errorBoundary(({ error }) => (
          <p>{`boundary:${error.segmentType}:${error.segmentId}`}</p>
        )),
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/photo/:id", () => <figure>photo</figure>, { name: "photo" }),
        intercept("@modal", ".photo", Modal),
      ]),
    ]),
  );

  it("names the intercept's slot, not the layout that declares it", async () => {
    const list = await serveShellRequest(router, "/list", { partial: true });
    const { metadata } = await deserializeResult<{
      metadata: { matched: string[] };
    }>(list.flight!);
    interceptThrows = true;
    const { flight } = await serveShellRequest(router, "/photo/1", {
      partial: { from: "/list", segments: metadata.matched },
    });
    expect(reports).toHaveLength(1);
    const { segmentType, segmentId } = reports[0]!;
    expect(segmentType).toBe("parallel");
    expect(segmentId).toMatch(/\.@modal$/);
    // The boundary's fallback is told the same segment.
    expect(flight).toContain(`boundary:parallel:${segmentId}`);
  });
});

describe("a streamed (loading()) handler's rejection", () => {
  const router = createRouter({ onError }).routes(
    urls(({ path, loading, errorBoundary }) => [
      path("/st", Streamed, { name: "st" }, () => [
        loading(<p>loading</p>),
        errorBoundary(Declared),
      ]),
    ]),
  );

  it.each([
    ["a document reports isPartial unset (unchanged)", undefined, undefined],
    ["a navigation reports isPartial true", true as const, true],
  ])("%s", async (_, partial, isPartial) => {
    failing = true;
    await serveShellRequest(router, "/st", { partial });
    await settle();
    expect(reports.map((r) => [r.phase, r.isPartial])).toStrictEqual([
      ["handler", isPartial],
    ]);
  });
});
