import { urls } from "@rangojs/router";
import { CookieTestLoader, CookieFromMiddlewareLoader } from "../loaders.js";
import { RequestContextReverseClient } from "../components/RequestContextReverseClient.js";

/**
 * Test patterns for LoaderContext cookie access and RequestContext reverse.
 *
 * Tests:
 * 1. Loader reads cookies via ctx.cookie() and ctx.cookies()
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
      middleware(async (ctx, next) => {
        const visitCount = parseInt(ctx.cookie("visit-count") || "0", 10);
        ctx.setCookie("visit-count", String(visitCount + 1), {
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
]);
