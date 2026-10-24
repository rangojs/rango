/**
 * A "use cache" function that takes the request context
 * (`getRequestContext()`) as an argument guards writes inside its body, on
 * every render pass, and nothing outside it.
 *
 * The derived passes (server/render-pass.ts: a ppr shell capture, a HIT
 * tail, a stale cache() record's background re-render) inherit the request
 * context's writers, and those check the request's own context. A cached body
 * that took that context as an argument used to stamp it for as long as the
 * body ran, so a write on another pass, outside any cached body, threw:
 *   - a background re-render failed and its record stayed stale;
 *   - a shell capture rendered the route's error boundary and stored it as
 *     the shell every later visitor gets.
 * The request's own writes outside the body threw too, while the same code
 * on a capture or a tail did not.
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
  getRequestContext,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";

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

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** What ran, in order: the body's entry and exit, and each write. */
const events: string[] = [];
const errors: string[] = [];

let entered: () => void = () => {};
let bodyEntered: Promise<void> = Promise.resolve();
let release: () => void = () => {};
let released: Promise<void> = Promise.resolve();

function holdNextBody(): void {
  bodyEntered = new Promise((resolve) => (entered = resolve));
  released = new Promise((resolve) => (release = resolve));
}

/**
 * Takes the request context for its env, as a data helper does. Stays in its
 * body until the write it is held for ran (or 500 ms).
 */
async function getCatalog(
  _rc: unknown,
  version: string,
): Promise<{ version: string }> {
  "use cache";
  events.push("body:enter");
  entered();
  await Promise.race([released, pause(500)]);
  events.push("body:leave");
  return { version };
}

/** Writes outside any cached body once a held body is running. */
async function writeWhileHeld(ctx: HandlerContext): Promise<void> {
  await Promise.race([bodyEntered, pause(500)]);
  events.push("write");
  try {
    getRequestContext().set("seen" as never, true as never);
    ctx.setLocationState([]);
  } finally {
    release();
  }
}

const routerOptions = {
  onError: ({ error }: { error: unknown }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
};

describe("a stale cache() record's background re-render", () => {
  let generation = 1;
  let holdOnRequest = 0;
  let request = 0;
  let pageRuns = 0;

  const CatalogLoader = createLoader(async () => {
    const version =
      request === holdOnRequest
        ? (await getCatalog(getRequestContext(), `v${request}`)).version
        : "none";
    return { version };
  });

  async function Page(ctx: HandlerContext): Promise<React.ReactNode> {
    pageRuns += 1;
    // The second run is the background re-render of the stale record.
    if (pageRuns === 2) await writeWhileHeld(ctx);
    return <p>{`page@g${generation}`}</p>;
  }

  const router = createRouter(routerOptions).routes(
    urls(({ path, cache, loader }) => [
      cache({ ttl: 0, swr: 60 }, () => [
        path("/catalog", Page, { name: "catalog" }, () => [
          loader(CatalogLoader),
        ]),
      ]),
    ]),
  );

  beforeEach(async () => {
    await resetShellTestState();
    events.length = 0;
    errors.length = 0;
    generation = 1;
    holdOnRequest = 0;
    request = 0;
    pageRuns = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes while a foreground loader's cached body holds the request context", async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const cacheStore = new VercelCacheStore({ cache: vercelCache() });

    request = 1;
    expect(
      (await serveShellRequest(router, "/catalog", { cacheStore })).body,
    ).toContain("page@g1");

    offset += 1_100;
    generation = 2;
    request = 2;
    holdOnRequest = 2;
    holdNextBody();
    const stale = await serveShellRequest(router, "/catalog", { cacheStore });
    expect(stale.body).toContain("page@g1");
    // The write ran on the background pass while the body held the context.
    expect(events).toEqual(["body:enter", "write", "body:leave"]);
    expect(errors).toEqual([]);

    offset += 1_100;
    request = 3;
    const refreshed = await serveShellRequest(router, "/catalog", {
      cacheStore,
    });
    expect(refreshed.body).toContain("page@g2");
  });
});

describe("a ppr shell capture", () => {
  let pageRuns = 0;

  const CatalogLoader = createLoader(async () => {
    const { version } = await getCatalog(getRequestContext(), "v1");
    return { version };
  });

  async function Page(ctx: HandlerContext): Promise<React.ReactNode> {
    pageRuns += 1;
    // The first run is the visitor's MISS, the second the capture.
    if (pageRuns === 2) await writeWhileHeld(ctx);
    return <p>shop</p>;
  }

  const router = createRouter(routerOptions).routes(
    urls(({ path, loader }) => [
      path("/shop", Page, { name: "shop", ppr: true }, () => [
        loader(CatalogLoader),
      ]),
    ]),
  );

  beforeEach(async () => {
    await resetShellTestState();
    events.length = 0;
    errors.length = 0;
    pageRuns = 0;
  });

  it("stores the page while the visitor's loader's cached body holds the request context", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    holdNextBody();
    const miss = await serveShellRequest(router, "/shop", { cacheStore });
    expect(miss.shellStatus).toBe("MISS");
    expect(events).toEqual(["body:enter", "write", "body:leave"]);
    expect(errors).toEqual([]);

    const hit = await serveShellRequest(router, "/shop", { cacheStore });
    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).toContain("shop");
    expect(hit.prelude).not.toContain('"error":{');
  });
});

describe("one outcome on every pass", () => {
  const outcomes: string[] = [];

  function attempt(pass: string, write: () => void): void {
    try {
      write();
      outcomes.push(`${pass}:ok`);
    } catch {
      outcomes.push(`${pass}:threw`);
    }
  }

  /** Writes through its request context argument inside the body. */
  async function writeInside(rc: any, pass: string): Promise<string[]> {
    "use cache";
    const threw: string[] = [];
    const writers: Record<string, () => void> = {
      set: () => rc.set("seen", true),
      header: () => rc.header("x-seen", "1"),
      setCookie: () => rc.setCookie("seen", "1"),
      deleteCookie: () => rc.deleteCookie("seen"),
      setStatus: () => rc.setStatus(203),
      onResponse: () => rc.onResponse((response: Response) => response),
      setLocationState: () => rc.setLocationState([]),
    };
    for (const [name, write] of Object.entries(writers)) {
      try {
        write();
      } catch {
        threw.push(name);
      }
    }
    return [`${pass}:${threw.join(",")}`];
  }

  /** Holds its argument for 30 ms. */
  async function getStock(_rc: unknown, pass: string): Promise<string> {
    "use cache";
    await pause(30);
    return pass;
  }

  /** A write outside the body while the body runs with the same context. */
  async function writeBeside(pass: string): Promise<void> {
    const rc = getRequestContext();
    await Promise.all([
      getStock(rc, pass),
      pause(5).then(() =>
        attempt(pass, () => rc.set("seen" as never, true as never)),
      ),
    ]);
  }

  let pageRuns = 0;
  let loaderRuns = 0;
  let mode: "beside" | "inside" = "beside";

  const StockLoader = createLoader(async () => {
    loaderRuns += 1;
    // The first run is the MISS's, the second the HIT tail's.
    const pass = loaderRuns === 1 ? "miss-loader" : "tail-loader";
    if (mode === "beside") await writeBeside(pass);
    else outcomes.push(...(await writeInside(getRequestContext(), pass)));
    return { ok: true };
  });

  async function Page(): Promise<React.ReactNode> {
    pageRuns += 1;
    const pass = pageRuns === 1 ? "miss" : "capture";
    if (mode === "beside") await writeBeside(pass);
    else outcomes.push(...(await writeInside(getRequestContext(), pass)));
    return <p>stock</p>;
  }

  const router = createRouter({}).routes(
    urls(({ path, loader }) => [
      path("/stock", Page, { name: "stock", ppr: true }, () => [
        loader(StockLoader),
      ]),
    ]),
  );

  beforeEach(async () => {
    await resetShellTestState();
    outcomes.length = 0;
    pageRuns = 0;
    loaderRuns = 0;
  });

  it("a write outside the cached body is allowed on the MISS, the capture and the HIT tail", async () => {
    mode = "beside";
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(router, "/stock", { cacheStore });
    const hit = await serveShellRequest(router, "/stock", { cacheStore });
    expect(hit.shellStatus).toBe("HIT");
    expect(outcomes.sort()).toEqual([
      "capture:ok",
      "miss-loader:ok",
      "miss:ok",
      "tail-loader:ok",
    ]);
  });

  it("every request-context write inside the cached body throws on the MISS, the capture and the HIT tail", async () => {
    mode = "inside";
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(router, "/stock", { cacheStore });
    const hit = await serveShellRequest(router, "/stock", { cacheStore });
    expect(hit.shellStatus).toBe("HIT");
    const all =
      "set,header,setCookie,deleteCookie,setStatus,onResponse,setLocationState";
    expect(outcomes.sort()).toEqual([
      `capture:${all}`,
      `miss-loader:${all}`,
      `miss:${all}`,
      `tail-loader:${all}`,
    ]);
  });
});
