/**
 * A route's loader bound with its own cache() whose body reads cookies()
 * (#972), served through the router's production request handler with
 * serveShellRequest (a plain document route, no ppr).
 *
 * The loader entry is keyed by loader, host, path and params, so without a
 * key() it is shared across users: the fill fails with the identity error,
 * which the router reports through onError, in either order: the binding
 * runs the body (/account), or a parent layout's handler reads the loader
 * before the route's binding starts and the MISS reuses that run
 * (/reader-first). With a key() that reads the cookie, each user gets their
 * own entry.
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
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { createHandle } from "../../handle.js";
import type { PartialCacheOptions } from "../../types/cache-types.js";

let runs = 0;

const SessionLoader = createLoader(async () => {
  runs++;
  return { session: `session-${cookies().get("session")?.value}` };
});

/** Reads cookies() in a nested promise, after the loader's value settled. */
const LateSessionLoader = createLoader(async () => ({
  session: (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return `late-${cookies().get("session")?.value}`;
  })(),
}));

const Crumbs = createHandle<unknown>(undefined, "test#IdentityCrumbs");

/** Pushes a crumb that reads cookies() after the loader's value settled. */
const CrumbLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)(
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `crumb-${cookies().get("session")?.value}`;
    })(),
  );
  return { page: "crumbs" };
});

/** Reads the route's cached loader before the route's loaders start. */
async function SessionLayout(ctx: HandlerContext): Promise<React.ReactNode> {
  const { session } = await ctx.use(SessionLoader);
  return <header>{`layout-${session}`}</header>;
}

async function AccountPage(ctx: HandlerContext): Promise<React.ReactNode> {
  const { session } = await ctx.use(SessionLoader);
  return <p>{session}</p>;
}

function makeRouter(cacheOptions: PartialCacheOptions) {
  const errors: string[] = [];
  const reports: Array<{ phase: string; category: unknown }> = [];
  const router = createRouter({
    onError: ({ error, phase, metadata }) => {
      errors.push((error as Error).message);
      reports.push({ phase, category: metadata?.category });
    },
  }).routes(
    urls(({ path, layout, loader, cache }) => [
      path("/account", AccountPage, { name: "account" }, () => [
        loader(SessionLoader, () => [cache(cacheOptions)]),
      ]),
      path(
        "/crumbs",
        () => <p>crumbs</p>,
        { name: "crumbs" },
        () => [loader(CrumbLoader, () => [cache(cacheOptions)])],
      ),
      path(
        "/late",
        () => <p>late</p>,
        { name: "late" },
        () => [loader(LateSessionLoader, () => [cache(cacheOptions)])],
      ),
      layout(SessionLayout, () => [
        path("/reader-first", AccountPage, { name: "readerFirst" }, () => [
          loader(SessionLoader, () => [cache(cacheOptions)]),
        ]),
      ]),
    ]),
  );
  return { router, errors, reports };
}

function serveAs(
  router: ReturnType<typeof makeRouter>["router"],
  cacheStore: MemorySegmentCacheStore,
  session: string,
  url = "/account",
) {
  return serveShellRequest(router, url, {
    cacheStore,
    headers: { accept: "text/html", cookie: `session=${session}` },
  });
}

beforeEach(async () => {
  runs = 0;
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a route loader's own cache() whose body reads cookies() (#972)", () => {
  it("without a key(): the read throws, nothing is stored, the second user never sees the first user's value", async () => {
    const { router, errors } = makeRouter({ ttl: 60 });
    const cacheStore = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(cacheStore, "setItem");

    const a = await serveAs(router, cacheStore, "a");
    const b = await serveAs(router, cacheStore, "b");

    expect(a.body).not.toContain("session-a");
    expect(b.body).not.toContain("session-a");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(
      /cookies\(\) cannot be called inside loader ".+", whose own cache\(\) has no key\(\)/,
    );
    expect(setItem).not.toHaveBeenCalled();
  });

  it("a parent layout's handler reads the loader first: the fill fails with the same error, and the second user never sees the first user's value", async () => {
    const { router, errors } = makeRouter({ ttl: 60 });
    const cacheStore = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(cacheStore, "setItem");

    const a = await serveAs(router, cacheStore, "a", "/reader-first");
    const b = await serveAs(router, cacheStore, "b", "/reader-first");

    // The layout's own read is live.
    expect(a.flight).toContain("layout-session-a");
    expect(b.flight).toContain("layout-session-b");
    expect(b.body).not.toContain("session-a");
    expect(runs).toBe(2);
    const bindingFirst = makeRouter({ ttl: 60 });
    await serveAs(bindingFirst.router, new MemorySegmentCacheStore(), "a");
    expect(errors[0]).toBe(bindingFirst.errors[0]);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("a read that settles after the value: the value is served to its own user, nothing is stored, and onError gets the error", async () => {
    const { router, errors } = makeRouter({ ttl: 60 });
    const cacheStore = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(cacheStore, "setItem");

    const a = await serveAs(router, cacheStore, "a", "/late");
    const b = await serveAs(router, cacheStore, "b", "/late");

    expect(a.response.status).toBe(200);
    expect(a.flight).toContain("late-a");
    expect(b.flight).toContain("late-b");
    expect(b.body).not.toContain("late-a");
    expect(setItem).not.toHaveBeenCalled();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(
      /cookies\(\) cannot be called inside loader ".+", whose own cache\(\) has no key\(\)/,
    );
  });

  it("a handle push that reads cookies() after the value settled: nothing is stored, the write is reported once, the response is intact", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { router, errors, reports } = makeRouter({ ttl: 60 });
      const cacheStore = new MemorySegmentCacheStore();
      const setItem = vi.spyOn(cacheStore, "setItem");

      const a = await serveAs(router, cacheStore, "a", "/crumbs");
      expect(reports).toEqual([{ phase: "cache", category: "cache-write" }]);
      const b = await serveAs(router, cacheStore, "b", "/crumbs");

      // Each visitor's own crumb, no error boundary.
      expect(a.response.status).toBe(200);
      expect(a.flight).toContain("crumb-a");
      expect(b.flight).toContain("crumb-b");
      expect(b.body).not.toContain("crumb-a");
      expect(a.body).not.toContain("cannot be called");
      expect(b.body).not.toContain("cannot be called");
      expect(setItem).not.toHaveBeenCalled();
      expect(reports).toHaveLength(2);
      expect(errors[0]).toMatch(
        /cookies\(\) cannot be called inside loader ".+", whose own cache\(\) has no key\(\)/,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("with a key() that reads the cookie: each user gets their own value, and a HIT serves the stored one", async () => {
    const { router, errors } = makeRouter({
      ttl: 60,
      key: () => `session:${cookies().get("session")?.value}`,
    });
    const cacheStore = new MemorySegmentCacheStore();

    const a = await serveAs(router, cacheStore, "a");
    const b = await serveAs(router, cacheStore, "b");
    const aAgain = await serveAs(router, cacheStore, "a");

    expect(a.flight).toContain("session-a");
    expect(b.flight).toContain("session-b");
    expect(b.flight).not.toContain("session-a");
    expect(aAgain.flight).toContain("session-a");
    expect(runs).toBe(2);
    expect(errors).toEqual([]);
  });
});
