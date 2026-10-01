/**
 * A "use cache" function that reads a loader's value with ctx.use() (#1011),
 * served twice through serveShellRequest with one store: visitor a, then
 * visitor b. The entry is keyed without the cookie the loader reads, so the
 * function refuses that value whichever code started the loader: the cached
 * function itself, a handler, the route's loader() binding, or a parent
 * layout's. Before #1011 only the first refused; the others stored visitor
 * a's value and served it to visitor b.
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
  cookies,
  createRouter,
  getRequestContext,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import {
  LateLoader,
  PlainLoader,
  ProfileLoader,
  UserLoader,
  counters,
  fireAndForget,
  greetingFor,
  lateGreeting,
  plainGreeting,
  profileCard,
  requestContextGreeting,
} from "./fixtures/memoized-loader-data.js";

const REFUSED = 'cookies() cannot be called inside a "use cache" function';

async function GreetingPage(ctx: HandlerContext): Promise<React.ReactNode> {
  return <p>{await greetingFor(ctx)}</p>;
}

async function HandlerFirstPage(ctx: HandlerContext): Promise<React.ReactNode> {
  const live = await ctx.use(UserLoader);
  return <p>{`live=${live}|${await greetingFor(ctx)}`}</p>;
}

async function ProfilePage(ctx: HandlerContext): Promise<React.ReactNode> {
  const live = await ctx.use(ProfileLoader);
  return <p>{`live=${live}|${await profileCard(ctx)}`}</p>;
}

async function PlainPage(ctx: HandlerContext): Promise<React.ReactNode> {
  const live = await ctx.use(PlainLoader);
  return <p>{`live=${live}|${await plainGreeting(ctx)}`}</p>;
}

async function PlainGreetingPage(
  ctx: HandlerContext,
): Promise<React.ReactNode> {
  return <p>{await plainGreeting(ctx)}</p>;
}

async function LatePage(ctx: HandlerContext): Promise<React.ReactNode> {
  await ctx.use(LateLoader);
  return <p>{await lateGreeting(ctx)}</p>;
}

async function RequestContextPage(): Promise<React.ReactNode> {
  const live = await getRequestContext().use(UserLoader);
  return <p>{`live=${live}|${await requestContextGreeting()}`}</p>;
}

async function FirePage(ctx: HandlerContext): Promise<React.ReactNode> {
  await ctx.use(UserLoader);
  return <p>{await fireAndForget(ctx)}</p>;
}

async function LiveUserPage(ctx: HandlerContext): Promise<React.ReactNode> {
  return <p>{`live=${await ctx.use(UserLoader)}`}</p>;
}

function Layout(): React.ReactNode {
  return <div>layout</div>;
}

function setup() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const errors: string[] = [];
  const router = createRouter({
    onError: ({ error }) => {
      errors.push((error as Error).message);
    },
  }).routes(
    urls(({ path, layout, loader, cache }) => [
      path("/cached-first", GreetingPage, { name: "cachedFirst" }),
      path("/handler-first", HandlerFirstPage, { name: "handlerFirst" }),
      path("/binding", GreetingPage, { name: "binding" }, () => [
        loader(UserLoader),
      ]),
      layout(Layout, () => [
        loader(UserLoader),
        path("/layout-binding", GreetingPage, { name: "layoutBinding" }),
      ]),
      path("/profile", ProfilePage, { name: "profile" }),
      path("/keyed-binding", GreetingPage, { name: "keyedBinding" }, () => [
        loader(UserLoader, () => [
          cache({ ttl: 60, key: () => `u:${cookies().get("u")?.value}` }),
        ]),
      ]),
      path("/plain", PlainPage, { name: "plain" }),
      path(
        "/plain-binding",
        PlainGreetingPage,
        { name: "plainBinding" },
        () => [loader(PlainLoader)],
      ),
      path("/late", LatePage, { name: "late" }),
      path("/request-context", RequestContextPage, { name: "requestContext" }),
      path("/fire", FirePage, { name: "fire" }),
      path("/ppr", HandlerFirstPage, { name: "ppr", ppr: true }),
      cache({ ttl: 60 }, () => [
        path("/route-cache", LiveUserPage, { name: "routeCache" }, () => [
          loader(UserLoader),
        ]),
      ]),
    ]),
  );
  const cacheStore = new MemorySegmentCacheStore();
  const serve = (url: string, u: string) =>
    serveShellRequest(router, url, {
      cacheStore,
      headers: { accept: "text/html", cookie: `u=${u}` },
    });
  return { serve, errors, cacheStore };
}

/** Reads the keys "use cache" wrote to `cacheStore` from here on. */
function spyUseCacheWrites(
  cacheStore: MemorySegmentCacheStore,
): () => string[] {
  const setItem = vi.spyOn(cacheStore, "setItem");
  return () =>
    setItem.mock.calls
      .map(([key]) => String(key))
      .filter((key) => key.startsWith("use-cache:"));
}

beforeEach(async () => {
  counters.cachedRuns = 0;
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('"use cache" reading a loader whose execution read cookies() (#1011)', () => {
  it.each([
    ["the cached function starts the loader", "/cached-first"],
    ["a handler starts the loader first", "/handler-first"],
    ["the route's loader() binding starts it", "/binding"],
    ["a parent layout's loader() binding starts it", "/layout-binding"],
    ["a handler starts a loader that reads it", "/profile"],
    [
      "both read it with getRequestContext().use() (the request context's runner)",
      "/request-context",
    ],
  ])(
    "refuses when %s: visitor b is never served visitor a's value",
    async (_label, url) => {
      const { serve, errors, cacheStore } = setup();
      const writes = spyUseCacheWrites(cacheStore);

      const a = await serve(url, "a");
      const b = await serve(url, "b");

      expect([a.response.status, b.response.status]).toEqual([500, 500]);
      expect(b.body + (b.flight ?? "")).not.toContain("user-a");
      expect(errors).toContainEqual(expect.stringContaining(REFUSED));
      expect(writes()).toEqual([]);
    },
  );

  it("names the loader that read the cookie and the loader the cached function reads", async () => {
    const { serve, errors } = setup();

    await serve("/profile", "a");

    const message = errors.find((e) => e.includes(REFUSED));
    expect(message).toContain(`Loader "${UserLoader.$$id}" called it`);
    expect(message).toContain(`reads loader "${ProfileLoader.$$id}"`);
  });

  it("refuses a keyed loader cache() binding's value on its MISS and its HIT", async () => {
    const { serve, errors } = setup();

    const a = await serve("/keyed-binding", "a");
    const b = await serve("/keyed-binding", "b");
    // The loader entry for visitor a is a HIT now.
    const aAgain = await serve("/keyed-binding", "a");

    expect([a, b, aAgain].map((s) => s.response.status)).toEqual([
      500, 500, 500,
    ]);
    expect(b.body + (b.flight ?? "")).not.toContain("user-a");
    expect(errors.filter((e) => e.includes(REFUSED))).toHaveLength(3);
  });

  it("a read that settles after the loader's value: each visitor gets their own value, nothing is stored, onError gets the error", async () => {
    const { serve, errors, cacheStore } = setup();
    const writes = spyUseCacheWrites(cacheStore);

    const a = await serve("/late", "a");
    const b = await serve("/late", "b");

    expect([a.response.status, b.response.status]).toEqual([200, 200]);
    expect(a.flight).toContain("greeting:late-a");
    expect(b.flight).toContain("greeting:late-b");
    expect(b.body + (b.flight ?? "")).not.toContain("late-a");
    expect(counters.cachedRuns).toBe(2);
    expect(writes()).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain(REFUSED);
  });

  it("a read the cached function never awaits: no unhandled rejection, nothing is stored, onError gets the error", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { serve, errors, cacheStore } = setup();
      const writes = spyUseCacheWrites(cacheStore);

      const a = await serve("/fire", "a");
      const b = await serve("/fire", "b");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect([a.response.status, b.response.status]).toEqual([200, 200]);
      expect(unhandled).toEqual([]);
      expect(writes()).toEqual([]);
      expect(errors).toEqual([
        expect.stringContaining(REFUSED),
        expect.stringContaining(REFUSED),
      ]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("on a ppr route: the render refuses once per request, and no shell is captured", async () => {
    const { serve, errors, cacheStore } = setup();
    const writes = spyUseCacheWrites(cacheStore);

    const a = await serve("/ppr", "a");
    const b = await serve("/ppr", "b");

    expect([a.response.status, b.response.status]).toEqual([500, 500]);
    expect([a.shellStatus, b.shellStatus]).toEqual(["MISS", "MISS"]);
    expect(b.body + (b.flight ?? "")).not.toContain("user-a");
    expect(errors).toEqual([
      expect.stringContaining(REFUSED),
      expect.stringContaining(REFUSED),
    ]);
    expect(writes()).toEqual([]);
  });
});

describe('"use cache" reading a loader that read no request identity', () => {
  it.each([
    ["a handler starts the loader first", "/plain"],
    ["the route's loader() binding starts the loader", "/plain-binding"],
  ])("stores and serves the value when %s", async (_label, url) => {
    const { serve, errors } = setup();

    const a = await serve(url, "a");
    const b = await serve(url, "b");

    expect([a.response.status, b.response.status]).toEqual([200, 200]);
    expect(b.flight).toContain("greeting:plain");
    expect(counters.cachedRuns).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe("a route cache() whose handler reads a cookie-reading loader", () => {
  it("still reads it: loader bodies are exempt under a route cache()", async () => {
    const { serve, errors } = setup();

    const a = await serve("/route-cache", "a");

    expect(a.response.status).toBe(200);
    expect(a.flight).toContain("live=user-a");
    expect(errors).toEqual([]);
  });
});
