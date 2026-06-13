import { urls, cookies, createVar } from "@rangojs/router";
import {
  CookieTestLoader,
  CookieFromMiddlewareLoader,
  ActionCookieLoader,
} from "../loaders.js";
import { RequestContextReverseClient } from "../components/RequestContextReverseClient.js";
import { ActionSetCookieButton } from "../components/ActionSetCookieButton.js";
import {
  ActionKeepCacheButton,
  ActionKeepThenInvalidateButton,
  InvalidateClientCacheButton,
} from "../components/ActionKeepCacheButton.js";

const MwSession = createVar<string | null>();

/**
 * Test patterns for LoaderContext cookie access and RequestContext reverse.
 *
 * Tests:
 * 1. Loader reads cookies via cookies().get() and cookies().getAll()
 * 2. Loader reads cookie set by middleware
 * 3. Server action uses getRequestContext().reverse()
 */
export const loaderCookiePatterns = urls(({ path, loader, middleware }) => [
  // Cookie test route: loader reads cookies directly
  path(
    "/",
    async (ctx) => {
      const cookieData = await ctx.use(CookieTestLoader);
      return (
        <div data-testid="loader-cookie-page">
          <h1 data-testid="loader-cookie-title">Loader Cookie Test</h1>
          <p data-testid="loader-cookie-session">
            {cookieData.session ?? "no-session"}
          </p>
          <p data-testid="loader-cookie-count">{cookieData.cookieCount}</p>
        </div>
      );
    },
    { name: "index" },
    () => [loader(CookieTestLoader)],
  ),

  // Cookie from middleware test: middleware sets visit-count, loader reads it
  path(
    "/from-middleware",
    async (ctx) => {
      const data = await ctx.use(CookieFromMiddlewareLoader);
      return (
        <div data-testid="loader-cookie-mw-page">
          <h1>Cookie from Middleware</h1>
          <p data-testid="loader-cookie-mw-visit-count">
            {data.visitCount !== null ? String(data.visitCount) : "null"}
          </p>
        </div>
      );
    },
    { name: "fromMiddleware" },
    () => [
      middleware(async (_ctx, next) => {
        const jar = cookies();
        const visitCount = parseInt(jar.get("visit-count")?.value || "0", 10);
        jar.set("visit-count", String(visitCount + 1), {
          path: "/",
          maxAge: 60 * 60 * 24,
        });
        await next();
      }),
      loader(CookieFromMiddlewareLoader),
    ],
  ),

  // RequestContext reverse test: action uses ctx.reverse()
  path(
    "/reverse-test",
    () => (
      <div data-testid="request-context-reverse-page">
        <h1>RequestContext Reverse Test</h1>
        <RequestContextReverseClient />
      </div>
    ),
    { name: "reverseTest" },
  ),

  // Action sets cookie, loader reads it via revalidation (read-after-write).
  // The action calls cookies().set(), then the server revalidates this route's
  // loader which calls cookies().get() and sees the value via the response
  // stub merge (same request, no navigation needed).
  path(
    "/action-sets-cookie",
    async (ctx) => {
      const data = await ctx.use(ActionCookieLoader);
      return (
        <div data-testid="action-sets-cookie-page">
          <h1>Action Sets Cookie</h1>
          <ActionSetCookieButton />
          <ActionKeepCacheButton />
          <ActionKeepThenInvalidateButton />
          <InvalidateClientCacheButton />
          <span data-testid="mw-session-value">
            {data.session ?? "no-session"}
          </span>
        </div>
      );
    },
    { name: "actionSetsCookie" },
    () => [loader(ActionCookieLoader)],
  ),

  // Route middleware reads a session cookie and exposes it via ctx.set().
  // After a server action mutates the cookie, the middleware-derived value
  // should be refreshed during same-request revalidation.
  path(
    "/mw-reads-cookie",
    async (ctx) => {
      const mwValue = ctx.get(MwSession);
      const data = await ctx.use(ActionCookieLoader);
      return (
        <div data-testid="mw-reads-cookie-page">
          <h1>Middleware Reads Cookie</h1>
          <ActionSetCookieButton />
          <span data-testid="mw-session-from-middleware">
            {mwValue ?? "no-session"}
          </span>
          <span data-testid="mw-session-from-loader">
            {data.session ?? "no-session"}
          </span>
        </div>
      );
    },
    { name: "mwReadsCookie" },
    () => [
      middleware(async (ctx, next) => {
        const session = cookies().get("mw-session")?.value ?? null;
        ctx.set(MwSession, session);
        await next();
      }),
      loader(ActionCookieLoader),
    ],
  ),

  // Middleware sets a response header AFTER await next() based on cookie state.
  // Tests that post-next() ctx.header() writes during the refresh pass are
  // propagated to the live response stub (not silently dropped).
  path(
    "/mw-post-next-header",
    async (ctx) => {
      const mwValue = ctx.get(MwSession);
      const data = await ctx.use(ActionCookieLoader);
      return (
        <div data-testid="mw-post-next-header-page">
          <h1>Middleware Post-Next Header</h1>
          <ActionSetCookieButton />
          <span data-testid="mw-post-next-from-middleware">
            {mwValue ?? "no-session"}
          </span>
          <span data-testid="mw-post-next-from-loader">
            {data.session ?? "no-session"}
          </span>
        </div>
      );
    },
    { name: "mwPostNextHeader" },
    () => [
      middleware(async (ctx, next) => {
        const session = cookies().get("mw-session")?.value ?? null;
        ctx.set(MwSession, session);
        await next();
        // Post-next header write using ctx.get() for the refreshed value.
        // Using the captured local `session` would be stale after an action
        // mutates the cookie because the outer middleware closure captured
        // it before the action ran.
        const current = ctx.get(MwSession);
        ctx.header("X-Auth-Status", current ? "authenticated" : "anonymous");
      }),
      loader(ActionCookieLoader),
    ],
  ),
]);
