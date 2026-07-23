import {
  cookies,
  headers,
  Breadcrumbs,
  getRequestContext,
} from "@rangojs/router";
import {
  CachedInlineActionForm,
  type CachedInlineActionState,
} from "../components/CachedInlineActionForm.js";
import { buildInlineActionState } from "../inline-action-helpers.js";

// Function-level "use cache" — each function has its own directive.

/**
 * Cached data function used inside a createLoader.
 * Proves that "use cache" works through the loader layer.
 */
export async function getCachedLoaderData(): Promise<{
  ts: number;
  rand: number;
}> {
  "use cache";
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * Named cache profile. Uses "use cache: short" which maps to the
 * "short" profile configured in createRouter({ cacheProfiles }).
 */
export async function getShortCachedData(): Promise<{
  ts: number;
  rand: number;
}> {
  "use cache: short";
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * Receives tainted ctx (HandlerContext) and pushes breadcrumb handles.
 * ctx is excluded from the cache key. On cache hit, handles are replayed
 * so breadcrumbs still appear.
 */
export async function fetchWithBreadcrumbs(
  ctx: any,
): Promise<{ ts: number; rand: number }> {
  "use cache";
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  pushBreadcrumb({
    label: "Cached Page",
    href: "/use-cache-test/with-handles",
  });
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * Slow cached data function for streaming test.
 * Takes 500ms on cache miss, instant on cache hit.
 */
export async function getSlowCachedData(): Promise<{
  ts: number;
  rand: number;
}> {
  "use cache";
  await new Promise((r) => setTimeout(r, 500));
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * Cached function that returns a React node (JSX) instead of plain data.
 * Has an internal await to verify async cache serialization works,
 * and the returned Promise<ReactNode> streams through a loading() boundary.
 *
 * Tests that RSC Flight serialize/deserialize roundtrip handles JSX
 * through the cache correctly.
 */
export async function getCachedReactNode(): Promise<React.ReactNode> {
  "use cache";
  await new Promise((r) => setTimeout(r, 200));
  const ts = Date.now();
  const rand = Math.random();
  return (
    <>
      <span data-testid="cached-node-ts">{ts}</span>
      <span data-testid="cached-node-rand">{rand}</span>
    </>
  );
}

/**
 * Cached function that accepts ReactNode slots (header, children).
 * Internal data (ts, rand) should be cached. Slot content should pass
 * through as temporary references, resolved from current call args
 * on cache hit (interleaving).
 */
export async function CachedWithSlots({
  header,
  children,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
}): Promise<React.ReactNode> {
  "use cache";
  const cachedTs = Date.now();
  const cachedRand = Math.random();
  return (
    <div data-testid="cached-with-slots">
      <div data-testid="cached-slots-header">{header}</div>
      <span data-testid="cached-slots-ts">{cachedTs}</span>
      <span data-testid="cached-slots-rand">{cachedRand}</span>
      <div data-testid="cached-slots-children">{children}</div>
    </div>
  );
}

/**
 * Cached data function for the action interleaving test.
 * Returns plain data (not JSX). The caller renders the client component
 * alongside this data, testing that server actions work next to cached data.
 */
export async function getCachedActionData(): Promise<{
  ts: number;
  rand: number;
}> {
  "use cache";
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * SWR test function with very short TTL (2s) and wide SWR window (60s).
 * Receives tainted ctx and pushes breadcrumbs to verify handle capture
 * through the stale-while-revalidate background path.
 */
export async function getSwrTestData(
  ctx: any,
): Promise<{ ts: number; rand: number }> {
  "use cache: swr-test";
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  pushBreadcrumb({
    label: "SWR Cached Page",
    href: "/use-cache-test/swr",
  });
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * SWR test function that reads the ambient request context via the standalone
 * getRequestContext() (the AsyncLocalStorage seat), NOT a passed-in handler ctx.
 * Mirrors the real consumer pattern `getRequestContext().env.ApiKey` inside a
 * "use cache" function. On a stale hit the function re-executes in a background
 * waitUntil task; that task must re-establish the request-context ALS, otherwise
 * getRequestContext() throws "called outside of a request context", the
 * revalidation fails, and the cached value is frozen forever. Short TTL (2s) via
 * the swr-test profile so the stale window opens fast.
 */
export async function getSwrCtxData(): Promise<{
  ts: number;
  rand: number;
  pathname: string;
}> {
  "use cache: swr-test";
  const ctx = getRequestContext();
  // Touch a context field (the ALS read is the part that throws when the
  // background task runs outside the request context).
  const pathname = ctx.url.pathname;
  return { ts: Date.now(), rand: Math.random(), pathname };
}

/**
 * Opt-in foreground-on-action test function. Uses the "swr-action" profile
 * (foregroundOnAction: true). On a stale hit during a plain navigation it keeps
 * SWR; on a stale hit during a server action's revalidation render it
 * re-executes in the FOREGROUND so the action response reflects a fresh value.
 * Reads the ambient getRequestContext() to confirm the context is available on
 * the foreground re-execution path too.
 */
export async function getSwrActionData(): Promise<{
  ts: number;
  rand: number;
  pathname: string;
}> {
  "use cache: swr-action";
  const ctx = getRequestContext();
  const pathname = ctx.url.pathname;
  return { ts: Date.now(), rand: Math.random(), pathname };
}

/**
 * Guard test: cookies() is called inside "use cache".
 * Receives tainted ctx so registerCachedFunction stamps INSIDE_CACHE_EXEC,
 * which causes cookies() to throw before reading anything.
 */
export async function cachedReadsCookies(ctx: any): Promise<string> {
  "use cache";
  cookies().get("test");
  return "no-throw";
}

/**
 * Guard test: headers() is called inside "use cache".
 * Same taint mechanism as cachedReadsCookies.
 */
export async function cachedReadsHeaders(ctx: any): Promise<string> {
  "use cache";
  headers().get("x-test");
  return "no-throw";
}

/**
 * Guard test: cookies() inside "use cache" with NO arguments. There is no
 * tainted arg to stamp, so the guard relies on registerCachedFunction always
 * stamping INSIDE_CACHE_EXEC on the ALS RequestContext.
 */
export async function cachedReadsCookiesNoArg(): Promise<string> {
  "use cache";
  cookies().get("test");
  return "no-throw";
}

/**
 * Guard test: headers() inside "use cache" with NO arguments. Same always-stamp
 * RequestContext path as cachedReadsCookiesNoArg.
 */
export async function cachedReadsHeadersNoArg(): Promise<string> {
  "use cache";
  headers().get("x-test");
  return "no-throw";
}

/**
 * Guard test: ctx.set() is called inside "use cache".
 * The handler-context set() should throw because side effects are lost on cache hit.
 */
export async function cachedCallsCtxSet(ctx: any): Promise<string> {
  "use cache";
  ctx.set("test-key", "test-value");
  return "no-throw";
}

/**
 * Guard test: ctx.headers.set() is called inside "use cache".
 * The guarded Headers proxy should throw on mutating methods.
 */
export async function cachedCallsCtxHeadersSet(ctx: any): Promise<string> {
  "use cache";
  ctx.headers.set("X-Test", "test-value");
  return "no-throw";
}

/**
 * Cached server component that creates an inline "use server" action and hands
 * it to a client component. Pins the cache + embedded-inline-action contract on
 * three axes at once:
 *
 * - capturedToken: the render-scope `token` the action CLOSES OVER is captured
 *   into the action's bound args (encryptActionBoundArgs in production) at
 *   cache-WRITE time. On a cache hit there is no re-render, so the action
 *   replays the frozen write-time token, identical to the cached rendered token.
 *   The token mixes Date.now() and Math.random() so a fresh render would differ,
 *   making the freeze observable across a reload.
 * - asyncValue: the action BODY runs live per invocation. Calling the module-
 *   level fetchRandomAsyncValue() returns a fresh value on every call, proving
 *   the body is not frozen with the cache.
 * - sessionCookie: cookies() read in the action body resolves against the LIVE
 *   POST request context. cookies() is forbidden inside "use cache", so it can
 *   only be read here, at invocation -- proving the action runs in the current
 *   request's scope, not the cached render's. See use-cache-inline-action.test.ts.
 */
export async function getCachedInlineActionShell(): Promise<React.ReactNode> {
  "use cache";
  const token = `tok-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;

  async function cachedInlineAction(
    _prev: CachedInlineActionState,
    _formData: FormData,
  ): Promise<CachedInlineActionState> {
    "use server";
    return buildInlineActionState(token);
  }

  return (
    <CachedInlineActionForm
      renderedToken={token}
      cachedAction={cachedInlineAction}
    />
  );
}
