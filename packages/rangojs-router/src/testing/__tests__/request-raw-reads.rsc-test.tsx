/**
 * #976: the raw request-identity reads, `ctx.request.headers` and
 * `getRequestContext().cookie()` / `.cookies()`, answer where `cookies()`
 * does. Served through the public serveShellRequest (the router's production
 * request handler):
 *
 * - a `ppr` route's capture refuses and the route stays on MISS, each visitor
 *   served their own value; a live loader reading the header HITs;
 * - a `cache()` route's miss fails, and nothing is stored for the next
 *   visitor;
 * - a `"use cache"` body throws; a header read by the caller and passed in
 *   keys the entry;
 * - a loader's own `cache()` without `key()` fails the fill; with a `key()`
 *   each visitor gets their own entry;
 * - `key()` reads the header freely and partitions the record;
 * - `fetch(ctx.request)`, `new Request(ctx.request)` and
 *   `ctx.request.clone()` inside a `cache()` boundary keep working: the
 *   platform copies the headers without the getter.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import React from "react";
import http from "node:http";
import type { AddressInfo } from "node:net";

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
  cookies,
  createLoader,
  createRouter,
  getRequestContext,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import {
  cachedRequestPath,
  cachedVisitor,
  cachedVisitorFromHeaders,
} from "./fixtures/raw-read-data.js";

function HeadersPage(ctx: HandlerContext): React.ReactNode {
  return <p>{`visitor-is-${ctx.request.headers.get("x-visitor")}`}</p>;
}

/** Left off the public type (use cookies()), reachable at runtime. */
interface RawCookieReads {
  cookie(name: string): string | undefined;
  cookies(): Record<string, string>;
}

const rawCookies = () => getRequestContext() as unknown as RawCookieReads;

function RcCookiePage(): React.ReactNode {
  return <p>{`cookie-is-${rawCookies().cookie("visitor")}`}</p>;
}

function RcCookiesPage(): React.ReactNode {
  return <p>{`cookies-is-${rawCookies().cookies().visitor}`}</p>;
}

let stamps = 0;

function StampPage(): React.ReactNode {
  stamps += 1;
  return <p>{`stamp-${stamps}`}</p>;
}

async function UseCacheHeadersPage(
  ctx: HandlerContext,
): Promise<React.ReactNode> {
  return <p>{await cachedVisitorFromHeaders(ctx)}</p>;
}

async function UseCacheArgPage(ctx: HandlerContext): Promise<React.ReactNode> {
  const visitor = ctx.request.headers.get("x-visitor");
  const [value, path] = await Promise.all([
    cachedVisitor(visitor),
    cachedRequestPath(ctx.request),
  ]);
  return <p>{`${value} ${path}`}</p>;
}

/** Copies the request three ways inside a cache() boundary. */
async function CopiesPage(ctx: HandlerContext): Promise<React.ReactNode> {
  const copy = new Request(ctx.request);
  const clone = ctx.request.clone();
  const echoed = await (await fetch(ctx.request)).text();
  return (
    <p>
      {`copy-${copy.method}-${copy.url === ctx.request.url} ` +
        `clone-${clone.url === ctx.request.url} fetch-${echoed}`}
    </p>
  );
}

let loaderRuns = 0;

const VisitorLoader = createLoader(async (ctx) => {
  loaderRuns += 1;
  return `loader-visitor-is-${ctx.request.headers.get("x-visitor")}-run-${loaderRuns}`;
});

const UnkeyedVisitorLoader = createLoader(
  async (ctx) => `unkeyed-visitor-is-${ctx.request.headers.get("x-visitor")}`,
);

type OnError = (error: unknown, context: { request?: Request }) => void;

function makeRouter(onError?: OnError) {
  return createRouter({
    onError: onError ? (context) => onError(context.error, context) : undefined,
  }).routes(
    urls(({ path, cache, loader, loading }) => [
      path("/ppr-headers", HeadersPage, { name: "pprHeaders", ppr: true }),
      path("/ppr-cookie", RcCookiePage, { name: "pprCookie", ppr: true }),
      path("/ppr-cookies", RcCookiesPage, { name: "pprCookies", ppr: true }),
      path(
        "/ppr-loader",
        () => <p>shell</p>,
        { name: "pprLoader", ppr: true },
        () => [loader(VisitorLoader), loading(<p>loading visitor</p>)],
      ),
      cache({ ttl: 300 }, () => [
        path("/cached-headers", HeadersPage, { name: "cachedHeaders" }),
        path("/cached-cookie", RcCookiePage, { name: "cachedCookie" }),
        path("/cached-cookies", RcCookiesPage, { name: "cachedCookies" }),
        path("/cached-copies", CopiesPage, { name: "cachedCopies" }),
        path(
          "/cached-throws",
          () => {
            throw new Error("boom");
          },
          { name: "cachedThrows" },
        ),
      ]),
      cache(
        {
          ttl: 300,
          key: (ctx) => `visitor:${ctx.request.headers.get("x-visitor")}`,
        },
        () => [path("/keyed", StampPage, { name: "keyed" })],
      ),
      cache(
        {
          ttl: 300,
          condition: (ctx) => ctx.request.headers.get("x-preview") !== "1",
        },
        () => [
          path("/ppr-conditioned", StampPage, {
            name: "pprConditioned",
            ppr: true,
          }),
        ],
      ),
      path("/ppr-partitioned", StampPage, {
        name: "pprPartitioned",
        ppr: true,
      }),
      cache(
        {
          ttl: 300,
          key: (ctx) => `visitor:${ctx.request.headers.get("x-visitor")}`,
          tags: (ctx) => [`visitor:${ctx.request.headers.get("x-visitor")}`],
        },
        () => [
          path("/ppr-tagged", StampPage, { name: "pprTagged", ppr: true }),
        ],
      ),
      path(
        "/loader-keyed",
        () => <p>loader keyed</p>,
        { name: "loaderKeyed" },
        () => [
          loader(VisitorLoader, () => [
            cache({
              ttl: 300,
              key: (ctx) => `visitor:${ctx.request.headers.get("x-visitor")}`,
            }),
          ]),
        ],
      ),
      path(
        "/loader-unkeyed",
        () => <p>loader unkeyed</p>,
        { name: "loaderUnkeyed" },
        () => [loader(UnkeyedVisitorLoader, () => [cache({ ttl: 300 })])],
      ),
      path("/use-cache-headers", UseCacheHeadersPage, {
        name: "useCacheHeaders",
      }),
      path("/use-cache-arg", UseCacheArgPage, { name: "useCacheArg" }),
      path("/plain-headers", HeadersPage, { name: "plainHeaders" }),
      path("/plain-cookie", RcCookiePage, { name: "plainCookie" }),
      path("/plain-cookies", RcCookiesPage, { name: "plainCookies" }),
    ]),
  );
}

function setup(
  onError?: OnError,
  cacheStore: MemorySegmentCacheStore = new MemorySegmentCacheStore(),
) {
  const router = makeRouter(onError);
  /** One request as `visitor`: the x-visitor header and the visitor cookie. */
  const serve = (url: string, visitor: string) =>
    serveShellRequest(router, url, {
      cacheStore,
      headers: { "x-visitor": visitor, cookie: `visitor=${visitor}` },
    });
  return { serve, cacheStore };
}

function refusalWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls
    .map((call: unknown[]) => call[0])
    .filter(
      (m: unknown): m is string =>
        typeof m === "string" && m.includes("was refused"),
    );
}

/** Collect onError errors' messages; console.error muted. */
function collectErrors() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const errors: unknown[] = [];
  const messages = () => errors.map((e) => (e as Error).message);
  return { onError: (error: unknown) => errors.push(error), messages };
}

/** Echoes the forwarded x-visitor header of any request. */
let echo: http.Server;
let echoOrigin: string;

beforeAll(async () => {
  echo = http.createServer((req, res) => {
    res.end(`echo-${req.headers["x-visitor"]}`);
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  echoOrigin = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => echo.close(resolve));
});

beforeEach(async () => {
  stamps = 0;
  loaderRuns = 0;
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** [surface, verb, route, text prefix] of the raw reads a handler can make. */
const HANDLER_READS: Array<[string, string, string, string]> = [
  ["ctx.request.headers", "read", "headers", "visitor-is-"],
  ["getRequestContext().cookie()", "called", "cookie", "cookie-is-"],
  ["getRequestContext().cookies()", "called", "cookies", "cookies-is-"],
];

describe("raw request-identity reads on a ppr route (#976)", () => {
  it.each(HANDLER_READS)(
    "%s refuses the capture, so no visitor gets a HIT with another visitor's value",
    async (surface, _verb, route, prefix) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { serve } = setup();

      const a = await serve(`/ppr-${route}`, "a");
      const b = await serve(`/ppr-${route}`, "b");

      expect([a.shellStatus, b.shellStatus]).toEqual(["MISS", "MISS"]);
      expect(a.flight).toContain(`${prefix}a`);
      expect(b.flight).toContain(`${prefix}b`);
      expect(b.body).not.toContain(`${prefix}a`);
      expect(await b.readEntry()).toBeNull();
      const refused = refusalWarnings(warn);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain(`read ${surface} during capture`);
      expect(refused[0]).toContain("a loader without ssr: false");
    },
  );

  it("a live loader reads ctx.request.headers on every request, HIT included", async () => {
    const { serve } = setup();

    await serve("/ppr-loader", "a");
    const hit = await serve("/ppr-loader", "b");

    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).not.toContain("loader-visitor-is-");
    expect(hit.flight).toContain("loader-visitor-is-b");
  });
});

describe('raw request-identity reads in cache() and "use cache" (#976)', () => {
  it.each(HANDLER_READS)(
    "%s in a cache() miss fails, and nothing is stored for the next visitor",
    async (surface, verb, route, prefix) => {
      const { onError, messages } = collectErrors();
      const { serve } = setup(onError);

      const a = await serve(`/cached-${route}`, "a");
      const b = await serve(`/cached-${route}`, "b");

      expect([a, b].map((served) => served.response.status)).toEqual([
        500, 500,
      ]);
      expect(b.body).not.toContain(`${prefix}a`);
      expect(messages()).toContainEqual(
        expect.stringContaining(
          `${surface} cannot be ${verb} inside a cache() boundary`,
        ),
      );
      expect(messages()).toContainEqual(
        expect.stringContaining("Read it inside a loader instead"),
      );
    },
  );

  it('ctx.request.headers in a "use cache" function throws instead of caching the first visitor\'s value', async () => {
    const { onError, messages } = collectErrors();
    const { serve } = setup(onError);

    const a = await serve("/use-cache-headers", "a");
    const b = await serve("/use-cache-headers", "b");

    expect([a, b].map((served) => served.response.status)).toEqual([500, 500]);
    expect(b.body).not.toContain("uc-visitor-is-a");
    expect(messages()).toContainEqual(
      expect.stringContaining(
        'ctx.request.headers cannot be read inside a "use cache" function',
      ),
    );
  });

  it("a header read by the caller and passed in keys the entry; a Request argument is keyed by its URL", async () => {
    const { serve } = setup();

    const a = await serve("/use-cache-arg", "a");
    const again = await serve("/use-cache-arg", "a");
    const b = await serve("/use-cache-arg", "b");

    expect(a.flight).toContain("uc-arg-visitor-is-a-call-1");
    expect(again.flight).toContain("uc-arg-visitor-is-a-call-1");
    expect(b.flight).toContain("uc-arg-visitor-is-b-call-2");
    expect(b.flight).toContain("uc-path-is-/use-cache-arg");
  });

  it.each(HANDLER_READS)(
    "%s outside cache() and ppr reads each visitor's value",
    async (_surface, _verb, route, prefix) => {
      const { serve } = setup();

      const a = await serve(`/plain-${route}`, "a");
      const b = await serve(`/plain-${route}`, "b");

      expect(a.flight).toContain(`${prefix}a`);
      expect(b.flight).toContain(`${prefix}b`);
    },
  );
});

describe("keyed reads of ctx.request.headers (#976)", () => {
  it("a route cache() key() reads the header and partitions the record", async () => {
    const { serve } = setup();

    const a = await serve("/keyed", "a");
    const again = await serve("/keyed", "a");
    const b = await serve("/keyed", "b");

    expect([a, again, b].map((served) => served.response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(a.flight).toContain("stamp-1");
    expect(again.flight).toContain("stamp-1");
    expect(b.flight).toContain("stamp-2");
  });

  it("a loader's own cache() with a key() reads the header in its body: each visitor gets their own entry", async () => {
    const { onError, messages } = collectErrors();
    const { serve } = setup(onError);

    const a = await serve("/loader-keyed", "a");
    const again = await serve("/loader-keyed", "a");
    const b = await serve("/loader-keyed", "b");

    expect(messages()).toEqual([]);
    expect(a.flight).toContain("loader-visitor-is-a-run-1");
    expect(again.flight).toContain("loader-visitor-is-a-run-1");
    expect(b.flight).toContain("loader-visitor-is-b-run-2");
  });

  // The capture resolves its doc record key again under the capture context,
  // where the keyGenerator runs: before, a cookies() read there refused
  // every capture of the route.
  it.each([
    [
      "ctx.request.headers",
      (ctx: { request: Request }) => ctx.request.headers.get("x-visitor"),
    ],
    ["cookies()", () => cookies().get("visitor")?.value],
  ])(
    "a store keyGenerator reads %s at capture too: each visitor's partition captures and HITs its own shell",
    async (_label, visitorOf) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { serve } = setup(
        undefined,
        new MemorySegmentCacheStore({
          keyGenerator: (ctx, defaultKey) => `${defaultKey}|${visitorOf(ctx)}`,
        }),
      );

      const a = await serve("/ppr-partitioned", "a");
      const aHit = await serve("/ppr-partitioned", "a");
      const b = await serve("/ppr-partitioned", "b");
      const bHit = await serve("/ppr-partitioned", "b");

      expect([a, aHit, b, bHit].map((served) => served.shellStatus)).toEqual([
        "MISS",
        "HIT",
        "MISS",
        "HIT",
      ]);
      expect(aHit.key).not.toBe(bHit.key);
      expect(refusalWarnings(warn)).toEqual([]);
    },
  );

  it("a condition() reads the header at capture too: the shell is stored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = setup();

    await serve("/ppr-conditioned", "a");
    const hit = await serve("/ppr-conditioned", "b");

    expect(hit.shellStatus).toBe("HIT");
    expect(refusalWarnings(warn)).toEqual([]);
  });

  // The capture writes the route record, and resolves its tags() there,
  // under the capture context. The tags are stored as metadata, never
  // rendered.
  it("a tags() function reads the header at capture too: the shell is stored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = setup();

    const statuses: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await serve("/ppr-tagged", "a")).shellStatus);
    }

    expect(statuses).toEqual(["MISS", "HIT", "HIT"]);
    expect(refusalWarnings(warn)).toEqual([]);
  });

  it("a loader's own cache() without a key() fails the fill on a ctx.request.headers read", async () => {
    const { onError, messages } = collectErrors();
    const { serve, cacheStore } = setup(onError);
    const setItem = vi.spyOn(cacheStore, "setItem");

    await serve("/loader-unkeyed", "a");
    const b = await serve("/loader-unkeyed", "b");

    expect(b.body).not.toContain("unkeyed-visitor-is-a");
    expect(messages()[0]).toMatch(
      /ctx\.request\.headers cannot be read inside loader ".+", whose own cache\(\) has no key\(\)/,
    );
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("onError reads the request (#976)", () => {
  it("when a handler inside a cache() boundary throws: onError observes, it renders nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const visitors: Array<string | null | undefined> = [];
    const { serve } = setup((_error, context) => {
      visitors.push(context.request?.headers.get("x-visitor"));
    });

    const served = await serve("/cached-throws", "a");

    expect(served.response.status).toBe(500);
    expect(visitors).toContain("a");
    expect(
      error.mock.calls.filter((call) =>
        String(call[0]).includes("onError] Callback error"),
      ),
    ).toEqual([]);
  });
});

describe("copies of ctx.request inside a cache() boundary (#976)", () => {
  it("fetch(ctx.request), new Request(ctx.request) and ctx.request.clone() work and read no header through the guard", async () => {
    const { onError, messages } = collectErrors();
    const { serve } = setup(onError);

    const served = await serve(`${echoOrigin}/cached-copies`, "a");

    expect(messages()).toEqual([]);
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("copy-GET-true clone-true fetch-echo-a");
  });
});
