/**
 * A redirect() thrown during the RSC render is control flow, as one a loader
 * throws is. A server component can only throw, and React's Flight renderer
 * turns that into an error row; the row's digest is the one channel to the
 * browser, so the render answers it with the redirect's own record
 * (rendered-redirect.ts). The router's boundaries mount LoaderRedirect for it
 * (route-content-wrapper.tsx, root-error-boundary.tsx), a document whose shell
 * it fails answers its 3xx (ssr/__tests__/shell-error-document.test.tsx), and
 * no cache writer stores it, because a redirect can depend on the request.
 *
 * The report: an account page's async gate throws redirect("/login") for a
 * visitor who is not signed in, and the visitor saw the error page instead of
 * /login, on a document load and on a click.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { Suspense } from "react";

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
  cache,
  createLocationState,
  createRouter,
  redirect,
  urls,
  type Middleware,
} from "../../index.rsc.js";
import { withLocationStateKey } from "../location-state-key.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { PREFETCH_FAILED_ROW } from "../../prefetch-markers.js";
import { renderedRedirectFromError } from "../../rendered-redirect.js";

/** The reported shape: an async gate inside a page component. */
async function AccountGate(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  throw redirect("/login");
}

function AccountPage(): React.ReactNode {
  return (
    <main>
      <h1>Account</h1>
      <AccountGate />
    </main>
  );
}

let accountRuns = 0;

function AccountHandler(): React.ReactNode {
  accountRuns += 1;
  return <AccountPage />;
}

function SyncGate(): React.ReactNode {
  throw redirect("/login");
}

function SuspendedGate(): React.ReactNode {
  return (
    <main>
      <h1>Account</h1>
      <Suspense fallback={<p>suspending</p>}>
        <AccountGate />
      </Suspense>
    </main>
  );
}

const Notice = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "Notice",
);

function StatefulGate(): React.ReactNode {
  throw redirect("/login", {
    status: 303,
    state: [Notice({ text: "Session expired" })],
  });
}

/** A handler streamed behind loading(): its throw surfaces in the same render. */
async function StreamedHandler(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  throw redirect("/login");
}

/** Not control flow: a raw Response keeps the documented error lane. */
function RawResponse(): React.ReactNode {
  throw new Response("plain text", { status: 200 });
}

function RawPage(): React.ReactNode {
  return <RawResponse />;
}

const Loading = <p>loading-fallback</p>;

const routes = urls(({ path, loading }) => [
  path("/", async () => <p>home</p>, { name: "home" }),
  path("/login", async () => <p>login-page</p>, { name: "login" }),
  path("/account", AccountHandler, { name: "account" }),
  // A component inside the handler's tree, not the handler itself: a
  // synchronous handler throw is the already-supported pre-stream redirect.
  path("/sync", () => <SyncGate />, { name: "sync" }),
  path("/suspended", () => <SuspendedGate />, { name: "suspended" }),
  path("/stateful", () => <StatefulGate />, { name: "stateful" }),
  path("/streamed", StreamedHandler, { name: "streamed" }, () => [
    loading(Loading),
  ]),
  path("/raw", RawPage, { name: "raw" }),
]);

/** Every redirect digest in a Flight payload, decoded as the browser decodes it. */
function redirectsIn(flight: string | undefined) {
  const rows = flight?.match(/^\d+:E(\{.*\})$/gm) ?? [];
  return rows
    .map((row) => {
      const error = JSON.parse(row.slice(row.indexOf(":E") + 2)) as {
        digest?: string;
      };
      return renderedRedirectFromError({ digest: error.digest });
    })
    .filter((redirect) => redirect !== undefined);
}

function makeRouter(options: { onError?: () => void } = {}) {
  return createRouter({ onError: options.onError }).routes(routes);
}

async function serve(
  url: string,
  options: { partial?: boolean; prefetch?: boolean } = {},
) {
  return serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(options.partial && { partial: { from: "/" } }),
    ...(options.prefetch && { partial: { from: "/", prefetch: true } }),
  });
}

beforeEach(() => resetShellTestState());

describe("a redirect thrown during the render", () => {
  it("a document carries the redirect for the browser, and reports nothing", async () => {
    const onError = vi.fn();
    const res = await serveShellRequest(
      createRouter({ onError }).routes(routes),
      "/account",
      { cacheStore: new MemorySegmentCacheStore() },
    );

    expect(redirectsIn(res.flight)).toEqual([
      { to: "http://localhost/login", status: 302 },
    ]);
    // Control flow, like a loader redirect: neither reported nor printed.
    expect(onError).not.toHaveBeenCalled();
  });

  it("a client navigation carries it too", async () => {
    const onError = vi.fn();
    const res = await serveShellRequest(
      createRouter({ onError }).routes(routes),
      "/account",
      {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: "/" },
      },
    );

    expect(redirectsIn(res.flight)).toEqual([
      { to: "http://localhost/login", status: 302 },
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("a synchronous throw, and one inside <Suspense>, answer the same", async () => {
    for (const url of ["/sync", "/suspended"]) {
      const res = await serve(url);
      expect(redirectsIn(res.flight)).toEqual([
        { to: "http://localhost/login", status: 302 },
      ]);
    }
  });

  it("a synchronous throw from the handler itself keeps its pre-stream 3xx", async () => {
    const res = await serveShellRequest(
      createRouter({}).routes(
        urls(({ path }) => [path("/direct", SyncGate, { name: "direct" })]),
      ),
      "/direct",
      { cacheStore: new MemorySegmentCacheStore() },
    );

    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/login");
    expect(redirectsIn(res.flight)).toEqual([]);
  });

  it("a handler streamed behind loading() is answered, not swallowed", async () => {
    const res = await serve("/streamed");

    expect(redirectsIn(res.flight)).toEqual([
      { to: "http://localhost/login", status: 302 },
    ]);
  });

  it("redirect(url, { status, state }) keeps both", async () => {
    const res = await serve("/stateful");

    expect(redirectsIn(res.flight)).toEqual([
      {
        to: "http://localhost/login",
        status: 303,
        state: { [Notice.__rsc_ls_key]: { text: "Session expired" } },
      },
    ]);
  });

  it("a prefetch of it is evicted: a redirect must not be replayed from a store", async () => {
    const res = await serve("/account", { prefetch: true });

    expect(res.body.endsWith(PREFETCH_FAILED_ROW)).toBe(true);
  });

  it("a cache() route refuses the record", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path }) => [
        path("/cached", AccountHandler, { name: "cached" }, () => [
          cache({ ttl: 60 }),
        ]),
      ]),
    );
    const res = await serveShellRequest(router, "/cached", { cacheStore });

    expect(redirectsIn(res.flight)).toHaveLength(1);
    expect(await res.readEntry()).toBeNull();
  });

  it("a document cache middleware never stores it", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const earlyCacheControl: Middleware = async (ctx, next) => {
      ctx.header("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
      await next();
    };
    const router = createRouter({ cache: { store: cacheStore } })
      .use(earlyCacheControl)
      .routes(routes);
    accountRuns = 0;
    const first = await serveShellRequest(router, "/account", { cacheStore });
    const second = await serveShellRequest(router, "/account", { cacheStore });

    expect(redirectsIn(first.flight)).toHaveLength(1);
    // A stored document would replay one visitor's redirect to the next
    // without running the handler again.
    expect(accountRuns).toBe(2);
    expect(redirectsIn(second.flight)).toHaveLength(1);
  });

  it("a raw Response is not control flow: it stays an error, reported once", async () => {
    const onError = vi.fn();
    const res = await serveShellRequest(
      createRouter({ onError }).routes(routes),
      "/raw",
      { cacheStore: new MemorySegmentCacheStore() },
    );

    expect(redirectsIn(res.flight)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
