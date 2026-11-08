/**
 * A component that throws redirect() while React renders it is answered by the
 * render, as a handler's throw is: a document request answers the redirect's
 * 3xx (with its location-state cookie, or the external opt-in), and a client
 * navigation answers 204 + X-RSC-Redirect, or the redirect payload when the
 * redirect carries location state.
 *
 * Only while the status is still open: a synchronous component's throw is in
 * the render's opening flush, so a Flight response holds that flush and answers
 * it; a document answers it once the shell is ready. An async component is a
 * task of its own, so its error row lands in a later chunk, after the response
 * committed: that case is pinned here as the documented limit
 * (docs/internal/execution-model.md, "A component that throws redirect()
 * redirects, if the render says so in time"). A real document render answers
 * the async case when the throw fails its shell, which needs real Fizz and is
 * covered by e2e (`e2e/component-redirect.test.ts` in both apps).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  createActionForm,
  resetShellTestState,
  serveShellRequest,
} from "../flight.entry.js";
import { withLocationStateKey } from "../location-state-key.js";
import {
  cookies,
  createLoader,
  createLocationState,
  createRouter,
  getRequestContext,
  loader,
  redirect,
  urls,
  type Middleware,
} from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";

/** A page component: React renders it, so its throw never reaches a handler. */
function SyncRedirectPage(): React.ReactNode {
  throw redirect("/target");
}

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "Flash",
);

function SyncStateRedirectPage(): React.ReactNode {
  throw redirect("/target", { state: [Flash({ text: "saved" })] });
}

function SyncExternalRedirectPage(): React.ReactNode {
  throw redirect("https://elsewhere.example/x", { external: true });
}

function SyncBlockedRedirectPage(): React.ReactNode {
  throw redirect("javascript:alert(1)");
}

let redirectOnRender = false;

function MaybeRedirectPage(): React.ReactNode {
  if (redirectOnRender) throw redirect("/target");
  return <p>page</p>;
}

function go(): string {
  "use server";
  redirectOnRender = true;
  return "ok";
}

/** An async component: its throw is a task of its own, reported later. */
async function AsyncRedirectPage(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  throw redirect("/target");
}

/** A layout and a parallel slot: components of the tree, not handlers. */
let layoutRedirects = false;
let slotRedirects = false;

function LayoutRedirectPage(): React.ReactNode {
  if (layoutRedirects) throw redirect("/target");
  return <p>layout</p>;
}

function SlotRedirect(): React.ReactNode {
  if (slotRedirects) throw redirect("/target");
  return <aside>side</aside>;
}

function layoutSlotRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, parallel }) => [
      path("/start", () => <p>start</p>, { name: "start" }),
      path("/target", () => <p>target-page</p>, { name: "target" }),
      layout(LayoutRedirectPage, () => [
        path("/inside", () => <p>inside</p>, { name: "inside" }),
        parallel({ "@side": SlotRedirect }),
      ]),
    ]),
  );
}

/** The same, streamed after a document's shell (an inline Suspense). */
async function StreamedRedirectPage(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  throw redirect("/target");
}

/** A page whose redirect is streamed after the shell, behind a cache header. */
function CachedStreamedRedirectPage(ctx: {
  headers: Headers;
}): React.ReactNode {
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  return (
    <React.Suspense fallback={<p>pending</p>}>
      <StreamedRedirectPage />
    </React.Suspense>
  );
}

/** A page that redirects on the re-render after a no-JS form post. */
let redirectOnFormRender = false;

function FormRedirectPage(): React.ReactNode {
  if (redirectOnFormRender) {
    throw redirect("/target", { state: [Flash({ text: "posted" })] });
  }
  return <p>page</p>;
}

async function postThenRedirect(_form: FormData): Promise<void> {
  redirectOnFormRender = true;
}

function RedirectingBoundary(): React.ReactNode {
  throw redirect("/target");
}

/**
 * An `errorBoundary()` fallback whose child throws the redirect, plus a count
 * of how often the render reached it. Which lanes render a declared fallback is
 * the fact these tests pin: a handler's failure builds an error segment
 * (`matchError` -> `createErrorSegment`), a loader's renders the fallback
 * through `renderErrorFallback` (`router/loader-resolution.ts`), a component
 * the segment walk invokes goes through `catchSegmentError` — and a component
 * React renders gets none of them.
 */
let boundaryFallbackRenders = 0;

function CountingRedirectingBoundary(): React.ReactNode {
  boundaryFallbackRenders += 1;
  throw redirect("/target");
}

/**
 * A page component that fails. Which lane its throw takes depends on how it is
 * mounted: returned by a handler, React renders it and the throw is an error
 * row with no fallback; passed to `path()` directly, the walk invokes it and
 * the throw is a resolution throw with an error segment. Both are pinned below.
 */
function FailingPage(): React.ReactNode {
  throw new Error("page boom");
}

/** A handler that fails: the render builds an error segment for it. */
function failingHandler(): React.ReactNode {
  throw new Error("handler boom");
}

/** A loader that fails: the render builds an error segment for it too. */
const FailingLoader = createLoader(() => {
  throw new Error("loader boom");
});

/** An action that fails: its boundary response renders the fallback. */
async function failingAction(): Promise<void> {
  throw new Error("action boom");
}

/** A streamed handler: it rejects after the response started. */
async function failingStreamedHandler(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  throw new Error("streamed boom");
}

async function failingFormAction(_form: FormData): Promise<void> {
  throw new Error("form boom");
}

let layoutBoom = false;
let slotBoom = false;

function MaybeFailingLayout(): React.ReactNode {
  if (layoutBoom) throw new Error("layout boom");
  return <p>layout</p>;
}

function MaybeFailingSlot(): React.ReactNode {
  if (slotBoom) throw new Error("slot boom");
  return <aside>side</aside>;
}

const patterns = urls(({ path, errorBoundary, loading, cache }) => [
  path("/start", () => <p>start</p>, { name: "start" }),
  path("/target", () => <p>target-page</p>, { name: "target" }),
  path("/sync", () => <SyncRedirectPage />, { name: "sync" }),
  path("/sync-state", () => <SyncStateRedirectPage />, { name: "syncState" }),
  path("/sync-external", () => <SyncExternalRedirectPage />, {
    name: "syncExternal",
  }),
  path("/sync-blocked", () => <SyncBlockedRedirectPage />, {
    name: "syncBlocked",
  }),
  // A declared boundary is no place for control flow: the redirect still
  // answers the response, the fallback never renders.
  path(
    "/sync-bounded",
    () => <SyncRedirectPage />,
    { name: "syncBounded" },
    () => [errorBoundary(({ error }) => <p>bounded:{error.message}</p>)],
  ),
  path("/async", () => <AsyncRedirectPage />, { name: "async" }),
  // A cache() route: the redirect answers before any record is written.
  path(
    "/cached",
    () => <SyncRedirectPage />,
    { name: "cached" },
    () => [cache({ ttl: 60 })],
  ),
  // The component renders inside a Suspense boundary: its sync throw is still
  // in the render's opening flush, and the document's shell is ready anyway.
  path(
    "/loading",
    () => <SyncRedirectPage />,
    { name: "loading" },
    () => [loading(<p>loading-fallback</p>)],
  ),
]);

/** A handler redirect: the lane a component's must match. */
function handlerRedirect(): Response {
  return redirect("/target");
}

const handlerPatterns = urls(({ path }) => [
  path("/start", () => <p>start</p>, { name: "start" }),
  path("/target", () => <p>target-page</p>, { name: "target" }),
  path("/handler", handlerRedirect, { name: "handler" }),
]);

/** Sets a cookie and registers an onResponse callback before the render. */
const stamp: Middleware = async (_ctx, next) => {
  cookies().set("probe", "1");
  getRequestContext().onResponse((response) => {
    const headers = new Headers(response.headers);
    headers.set("x-probe", "seen");
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  });
  return next();
};

function makeRouter(basename?: string, middleware?: Middleware) {
  const router = createRouter({ basename }).routes(patterns);
  return middleware ? router.use(middleware) : router;
}

function makeHandlerRouter() {
  return createRouter({}).routes(handlerPatterns).use(stamp);
}

/**
 * One route per lane that can render a declared fallback, each fallback's child
 * throwing the redirect: a component's own error (no error segment), a
 * handler's, a loader's and an action's error (an error segment before the
 * flush), and a streamed handler's error (an error segment after the response
 * started).
 */
function boundaryFallbackRouter(onError: (error: unknown) => void) {
  return createRouter({ onError }).routes(
    urls(({ path, errorBoundary, loader, loading }) => [
      path("/start", () => <p>start</p>, { name: "start" }),
      path("/target", () => <p>target-page</p>, { name: "target" }),
      path(
        "/boom",
        () => <FailingPage />,
        { name: "boom" },
        () => [errorBoundary(() => <CountingRedirectingBoundary />)],
      ),
      path("/handler-boom", failingHandler, { name: "handlerBoom" }, () => [
        errorBoundary(() => <CountingRedirectingBoundary />),
      ]),
      path(
        "/loader-boom",
        () => <p>page</p>,
        { name: "loaderBoom" },
        () => [
          loader(FailingLoader),
          errorBoundary(() => <CountingRedirectingBoundary />),
        ],
      ),
      path(
        "/action-boom",
        () => <p>page</p>,
        { name: "actionBoom" },
        () => [errorBoundary(() => <CountingRedirectingBoundary />)],
      ),
      path(
        "/streamed-boom",
        failingStreamedHandler,
        { name: "streamedBoom" },
        () => [
          loading(<p>pending</p>),
          errorBoundary(() => <CountingRedirectingBoundary />),
        ],
      ),
    ]),
  );
}

/**
 * The lanes where the walk invokes the component — a page passed to `path()`
 * directly, a layout body, a slot body — each declaring its own fallback whose
 * child throws the redirect.
 */
function invokedBoundaryRouter(onError: (error: unknown) => void) {
  return createRouter({ onError }).routes(
    urls(({ path, layout, parallel, errorBoundary }) => [
      path("/start", () => <p>start</p>, { name: "start" }),
      path("/target", () => <p>target-page</p>, { name: "target" }),
      path("/direct-boom", FailingPage, { name: "directBoom" }, () => [
        errorBoundary(() => <CountingRedirectingBoundary />),
      ]),
      layout(MaybeFailingLayout, () => [
        errorBoundary(() => <CountingRedirectingBoundary />),
        path("/inside", () => <p>inside</p>, { name: "inside" }),
        parallel({
          "@side": {
            handler: MaybeFailingSlot,
            use: () => [errorBoundary(() => <CountingRedirectingBoundary />)],
          },
        }),
      ]),
    ]),
  );
}

function documentRequest(path: string, basename?: string) {
  return serveShellRequest(makeRouter(basename), path, {
    cacheStore: new MemorySegmentCacheStore(),
  });
}

function navigation(from: string, path: string, basename?: string) {
  return serveShellRequest(makeRouter(basename), path, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: { from },
  });
}

/** What a redirecting request leaves on its response besides the redirect. */
function stamps(response: Response) {
  return {
    status: response.status,
    cookie: response.headers.get("Set-Cookie"),
    onResponse: response.headers.get("x-probe"),
  };
}

beforeEach(() => {
  layoutRedirects = false;
  slotRedirects = false;
  layoutBoom = false;
  slotBoom = false;
  boundaryFallbackRenders = 0;
  resetShellTestState();
});

describe("a component's redirect (serveShellRequest)", () => {
  it("document: answers the redirect's 3xx, not the boundary", async () => {
    const res = await documentRequest("/sync");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/target");
    expect(res.flight).toBeUndefined();
  });

  it("document: carries the redirect's location state in the state cookie", async () => {
    const res = await documentRequest("/sync-state");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/target");
    expect(res.response.headers.get("Set-Cookie")).toContain("rango-state");
  });

  it("document: keeps an explicit off-host target", async () => {
    const res = await documentRequest("/sync-external");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe(
      "https://elsewhere.example/x",
    );
  });

  it("document: neutralizes an unsafe scheme to the app root", async () => {
    const res = await documentRequest("/sync-blocked");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/");
  });

  it("document: keeps a root-relative target under the basename", async () => {
    const res = await documentRequest("/app/sync", "/app");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/app/target");
  });

  it("strictMode: the double render still answers it on both lanes", async () => {
    // React renders twice under strict mode: the first throw wins, so the
    // second render's copy neither overwrites nor consumes it.
    const router = createRouter({ strictMode: true }).routes(patterns);
    const document = await serveShellRequest(router, "/sync", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(document.response.status).toBe(302);
    expect(document.response.headers.get("Location")).toBe("/target");
    const nav = await serveShellRequest(router, "/sync", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/start" },
    });
    expect(nav.response.status).toBe(204);
    expect(nav.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("document: a declared errorBoundary does not intercept it", async () => {
    const res = await documentRequest("/sync-bounded");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/target");
  });

  it("navigation: answers 204 + X-RSC-Redirect", async () => {
    const res = await navigation("/start", "/sync");
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
    expect(res.flight).toBeUndefined();
  });

  it("navigation: a root-relative target keeps the basename", async () => {
    const res = await navigation("/app/start", "/app/sync", "/app");
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/app/target",
    );
  });

  it("navigation: a declared errorBoundary does not intercept it", async () => {
    const res = await navigation("/start", "/sync-bounded");
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("navigation: a redirect with location state travels as the redirect payload", async () => {
    const res = await navigation("/start", "/sync-state");
    expect(res.response.status).toBe(200);
    expect(await res.readRedirect()).toEqual({
      url: "http://localhost/target",
    });
    expect(await res.readLocationState()).toEqual({
      [Flash.__rsc_ls_key]: { text: "saved" },
    });
  });

  it("navigation: an explicit off-host target travels as the redirect payload", async () => {
    const res = await navigation("/start", "/sync-external");
    expect(res.response.status).toBe(200);
    expect(await res.readRedirect()).toEqual({
      url: "https://elsewhere.example/x",
      external: true,
    });
  });

  it("prefetch: answers the redirect instead of a body a click would adopt", async () => {
    const res = await serveShellRequest(makeRouter(), "/sync", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/start", prefetch: true },
    });
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("leaves what a handler's redirect leaves: the cookie and the onResponse callback", async () => {
    // The response is built only after the render's opening flush answered the
    // redirect, so the request's stub is untouched: the cookie and every
    // onResponse callback are on the 204 exactly as on a handler's.
    const handlerLane = await serveShellRequest(
      makeHandlerRouter(),
      "/handler",
      {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: "/start" },
      },
    );
    const componentLane = await serveShellRequest(
      makeRouter(undefined, stamp),
      "/sync",
      {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: "/start" },
      },
    );
    expect(stamps(componentLane.response)).toEqual(
      stamps(handlerLane.response),
    );
    expect(stamps(componentLane.response)).toEqual({
      status: 204,
      cookie: "probe=1",
      onResponse: "seen",
    });
    const document = await serveShellRequest(
      makeRouter(undefined, stamp),
      "/sync",
      { cacheStore: new MemorySegmentCacheStore() },
    );
    expect(stamps(document.response)).toEqual({
      status: 302,
      cookie: "probe=1",
      onResponse: "seen",
    });
  });

  it("reports nothing to onError: a redirect is control flow, as for a handler", async () => {
    const onError = vi.fn();
    const router = createRouter({ onError }).routes(patterns);
    const res = await serveShellRequest(router, "/sync", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/start" },
    });
    expect(res.response.status).toBe(204);
    expect(onError).not.toHaveBeenCalled();
  });

  it("loading() route: both lanes answer it, the fallback never renders", async () => {
    const document = await documentRequest("/loading");
    expect(document.response.status).toBe(302);
    expect(document.response.headers.get("Location")).toBe("/target");
    const nav = await navigation("/start", "/loading");
    expect(nav.response.status).toBe(204);
    expect(nav.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("cache() route: answered every time, never stored", async () => {
    const router = makeRouter();
    const store = new MemorySegmentCacheStore();
    for (const attempt of ["first", "second"]) {
      const res = await serveShellRequest(router, "/cached", {
        cacheStore: store,
        partial: { from: "/start" },
      });
      expect(res.response.status, attempt).toBe(204);
      expect(res.response.headers.get("X-RSC-Redirect"), attempt).toBe(
        "http://localhost/target",
      );
    }
  });

  it("action revalidation: the re-render answers it as a handler's redirect is answered", async () => {
    redirectOnRender = false;
    const router = createRouter({}).routes(
      urls(({ path }) => [
        path("/page", () => <MaybeRedirectPage />, { name: "page" }),
        path("/target", () => <p>target-page</p>, { name: "target" }),
      ]),
    );
    const res = await serveShellRequest(router, "/page", {
      cacheStore: new MemorySegmentCacheStore(),
      action: { ref: go, id: "component-redirect#go", args: [] },
    });
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("layout and parallel slot components answer it on both lanes", async () => {
    layoutRedirects = true;
    const layoutDoc = await serveShellRequest(layoutSlotRouter(), "/inside", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(layoutDoc.response.status).toBe(302);
    expect(layoutDoc.response.headers.get("Location")).toBe("/target");
    const layoutNav = await serveShellRequest(layoutSlotRouter(), "/inside", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/start" },
    });
    expect(layoutNav.response.status).toBe(204);
    expect(layoutNav.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );

    layoutRedirects = false;
    slotRedirects = true;
    const slotDoc = await serveShellRequest(layoutSlotRouter(), "/inside", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(slotDoc.response.status).toBe(302);
    expect(slotDoc.response.headers.get("Location")).toBe("/target");
    const slotNav = await serveShellRequest(layoutSlotRouter(), "/inside", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/start" },
    });
    expect(slotNav.response.status).toBe(204);
    expect(slotNav.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("intercept: a component's redirect answers 204 + X-RSC-Redirect", async () => {
    const router = createRouter({}).routes(
      urls(({ path, intercept }) => [
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/photo/:id", () => <figure>photo</figure>, { name: "photo" }),
        intercept("@modal", ".photo", () => <SyncRedirectPage />),
        path("/target", () => <p>target-page</p>, { name: "target" }),
      ]),
    );
    const res = await serveShellRequest(router, "/photo/1", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/list" },
    });
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("not-found component: a document request answers its redirect, not a 500", async () => {
    const router = createRouter({
      notFound: () => <SyncRedirectPage />,
    }).routes(patterns);
    const res = await serveShellRequest(router, "/missing", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/target");
  });

  it("not-found component: a navigation answers 204 + X-RSC-Redirect", async () => {
    const router = createRouter({
      notFound: () => <SyncRedirectPage />,
    }).routes(patterns);
    const res = await serveShellRequest(router, "/missing", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/start" },
    });
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("no-JS form post: the re-render answers the redirect's 3xx and its state", async () => {
    redirectOnFormRender = false;
    const router = createRouter({}).routes(
      urls(({ path }) => [
        path("/page", () => <FormRedirectPage />, { name: "page" }),
        path("/target", () => <p>target-page</p>, { name: "target" }),
      ]),
    );
    const res = await serveShellRequest(router, "/page", {
      cacheStore: new MemorySegmentCacheStore(),
      form: createActionForm(postThenRedirect, {
        id: "component-redirect#postThenRedirect",
        useActionState: false,
      }),
    });
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/target");
    expect(res.response.headers.get("Set-Cookie")).toContain("rango-state");
  });

  it("no-JS form post: a redirect from the error-boundary render answers the 3xx", async () => {
    const router = createRouter({}).routes(
      urls(({ path, errorBoundary }) => [
        path(
          "/page",
          () => <p>page</p>,
          { name: "page" },
          () => [errorBoundary(() => <RedirectingBoundary />)],
        ),
        path("/target", () => <p>target-page</p>, { name: "target" }),
      ]),
    );
    const res = await serveShellRequest(router, "/page", {
      cacheStore: new MemorySegmentCacheStore(),
      form: createActionForm(failingFormAction, {
        id: "component-redirect#failingFormAction",
        useActionState: false,
      }),
    });
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/target");
  });

  it("never stored: a streamed redirect's 200 is refused by both caches", async () => {
    // The response committed before the throw, so the 200 it answers carries
    // the error row: the document cache and the shell capture must refuse it
    // (the Response stays in _renderErrors), or every later HIT serves it.
    const store = new MemorySegmentCacheStore();
    const router = createRouter({})
      .use(createDocumentCacheMiddleware())
      .routes(
        urls(({ path }) => [
          path("/cached-streamed", CachedStreamedRedirectPage, {
            name: "cachedStreamed",
          }),
          path(
            "/shelled-streamed",
            () => (
              <React.Suspense fallback={<p>pending</p>}>
                <StreamedRedirectPage />
              </React.Suspense>
            ),
            { name: "shelledStreamed", ppr: true },
          ),
          path("/target", () => <p>target-page</p>, { name: "target" }),
        ]),
      );
    const cachedFirst = await serveShellRequest(router, "/cached-streamed", {
      cacheStore: store,
    });
    const cachedSecond = await serveShellRequest(router, "/cached-streamed", {
      cacheStore: store,
    });
    expect(cachedFirst.response.status).toBe(200);
    expect(cachedSecond.response.headers.get("x-document-cache-status")).toBe(
      "MISS",
    );
    expect(await cachedSecond.readEntry()).toBeNull();

    const shelledFirst = await serveShellRequest(router, "/shelled-streamed", {
      cacheStore: store,
    });
    const shelledSecond = await serveShellRequest(router, "/shelled-streamed", {
      cacheStore: store,
    });
    expect(shelledFirst.shellStatus).toBe("MISS");
    expect(shelledSecond.shellStatus).toBe("MISS");
    expect(await shelledFirst.readEntry()).toBeNull();
  });

  it("limit: a redirect streamed after the shell (inline Suspense) is out of time", async () => {
    // Pinned, not wanted: the shell is out before the component throws, so a
    // document answers the 200 it committed. The same route without the
    // Suspense boundary answers the redirect (documentRequest("/async") in a
    // real render), which needs real Fizz and is covered by e2e.
    const onError = vi.fn();
    const router = createRouter({ onError }).routes(
      urls(({ path }) => [
        path(
          "/streamed",
          () => (
            <React.Suspense fallback={<p>pending</p>}>
              <StreamedRedirectPage />
            </React.Suspense>
          ),
          { name: "streamed" },
        ),
        path("/target", () => <p>target-page</p>, { name: "target" }),
      ]),
    );
    const res = await serveShellRequest(router, "/streamed", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(res.response.status).toBe(200);
    expect(res.flight).toContain('"digest"');
    expect(res.response.headers.get("Location")).toBeNull();
    // Out of time is a failure, not control flow: nothing answers this
    // redirect, so the render reports it like any other rendering error.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ phase: "rendering" });
  });

  it("limit: an async component's redirect is reported after the status commits, so the boundary renders", async () => {
    // Pinned, not wanted: see the module comment. The document lane answers it
    // in a real render (its shell fails first), the Flight lane cannot.
    const onError = vi.fn();
    const router = createRouter({ onError }).routes(patterns);
    const res = await serveShellRequest(router, "/async", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/start" },
    });
    expect(res.response.status).toBe(200);
    expect(res.flight).toContain('"digest"');
    expect(res.response.headers.get("X-RSC-Redirect")).toBeNull();
    // The visitor is shown an error page, so the consumer must hear about it:
    // onError is the only signal that the navigation's redirect did not land.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ phase: "rendering" });
  });

  it("limit: a component's own error renders no declared fallback, so a redirect in one answers nothing", async () => {
    // Pinned, not wanted: this component is React-rendered (a handler returned
    // the element), so its throw is an error row and nothing else — no error
    // segment, so no declared fallback renders, so a redirect thrown from one
    // is never a value the render sees. The walk-invoked lanes (a page passed
    // to path(), a layout or slot body) do build an error segment and are
    // pinned below. See docs/internal/execution-model.md, "A component that
    // throws redirect() redirects, if the render says so in time".
    const onError = vi.fn();
    const router = boundaryFallbackRouter(onError);

    const document = await serveShellRequest(router, "/boom", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(document.response.status).toBe(200);
    expect(document.response.headers.get("Location")).toBeNull();
    expect(document.flight).toContain('"digest"');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ phase: "rendering" });

    onError.mockClear();
    const nav = await serveShellRequest(router, "/boom", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/start" },
    });
    expect(nav.response.status).toBe(200);
    expect(nav.response.headers.get("X-RSC-Redirect")).toBeNull();
    expect(nav.flight).toContain('"digest"');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ phase: "rendering" });

    // Nothing rendered the fallback, so nothing threw from it: the redirect is
    // not a value the render ever sees.
    expect(boundaryFallbackRenders).toBe(0);
  });

  it("a handler's, a loader's or an action's error renders the fallback, so its redirect is answered", async () => {
    // The lanes whose error segment renders before the flush: a synchronous
    // handler, a loader, and an action's boundary response.
    for (const route of ["/handler-boom", "/loader-boom"]) {
      const onError = vi.fn();
      const router = boundaryFallbackRouter(onError);

      const document = await serveShellRequest(router, route, {
        cacheStore: new MemorySegmentCacheStore(),
      });
      expect(document.response.status).toBe(302);
      expect(document.response.headers.get("Location")).toBe("/target");

      const nav = await serveShellRequest(router, route, {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: "/start" },
      });
      // The header steers the browser whatever status the error lane answers
      // (browser/navigation-client.ts).
      expect(nav.response.headers.get("X-RSC-Redirect")).toBe(
        "http://localhost/target",
      );
      // Answered is control flow: the render reports it to nobody.
      expect(
        onError.mock.calls.filter(
          (call) => (call[0] as { phase?: string }).phase === "rendering",
        ),
      ).toEqual([]);
    }

    const action = await serveShellRequest(
      boundaryFallbackRouter(vi.fn()),
      "/action-boom",
      {
        cacheStore: new MemorySegmentCacheStore(),
        action: {
          ref: failingAction,
          id: "component-redirect#failingAction",
          args: [],
        },
      },
    );
    expect(action.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
    expect(boundaryFallbackRenders).toBeGreaterThan(0);
  });

  it("a component the walk invokes builds an error segment, so its fallback's redirect is answered", async () => {
    // The lanes the segment walk invokes — a page passed to path() directly, a
    // layout body, a slot body — throw while resolving, so catchSegmentError
    // builds an error segment: the declared fallback renders, and the redirect
    // it throws is answered while the window is open, as a handler's error
    // lane is. Only a component React renders is an error row with no fallback
    // (the pin above).
    const lanes = [
      { name: "direct", path: "/direct-boom", layout: false, slot: false },
      { name: "layout", path: "/inside", layout: true, slot: false },
      { name: "slot", path: "/inside", layout: false, slot: true },
    ];
    for (const lane of lanes) {
      boundaryFallbackRenders = 0;
      layoutBoom = lane.layout;
      slotBoom = lane.slot;
      const onError = vi.fn();
      const router = invokedBoundaryRouter(onError);

      const document = await serveShellRequest(router, lane.path, {
        cacheStore: new MemorySegmentCacheStore(),
      });
      expect(document.response.status, lane.name).toBe(302);
      expect(document.response.headers.get("Location"), lane.name).toBe(
        "/target",
      );
      expect(boundaryFallbackRenders, lane.name).toBe(1);

      const nav = await serveShellRequest(router, lane.path, {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: "/start" },
      });
      // The error lane answers its own status beside the header; the browser
      // steers on the header whatever it is (browser/navigation-client.ts).
      expect(nav.response.headers.get("X-RSC-Redirect"), lane.name).toBe(
        "http://localhost/target",
      );
      expect(nav.response.status, lane.name).toBe(500);
      // Answered is control flow: the render reports the redirect to nobody.
      expect(
        onError.mock.calls.filter(
          (call) => (call[0] as { phase?: string }).phase === "rendering",
        ),
        lane.name,
      ).toEqual([]);
    }
  });

  it("limit: a streamed handler's error segment is out of time, so its fallback's redirect is reported, not answered", async () => {
    // Pinned, not wanted: loading() starts the response before the handler
    // settles, so the fallback renders after the status committed. The
    // redirect is a late one: answered by nobody, reported as a rendering
    // error beside the handler's own failure.
    const onError = vi.fn();
    const router = boundaryFallbackRouter(onError);

    const document = await serveShellRequest(router, "/streamed-boom", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(document.response.status).toBe(200);
    expect(document.response.headers.get("Location")).toBeNull();
    expect(document.response.headers.get("X-RSC-Redirect")).toBeNull();
    expect(boundaryFallbackRenders).toBeGreaterThan(0);
    expect(
      onError.mock.calls.map((call) => (call[0] as { phase?: string }).phase),
    ).toEqual(["handler", "rendering"]);
  });
});
