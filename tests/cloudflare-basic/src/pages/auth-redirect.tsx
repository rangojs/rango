import { cookies, redirect, urls } from "@rangojs/router";

// #1047: a page whose route middleware redirects to the public target unless
// the "auth-redirect-token" cookie is set.
export const authRedirectPatterns = urls(({ path, middleware }) => [
  path(
    "/",
    (ctx) => (
      <div data-testid="auth-redirect-target">
        <h1 data-testid="auth-redirect-target-title">Auth Redirect Target</h1>
        <p data-testid="auth-redirect-rejected">
          {ctx.searchParams.get("rejected") ?? "none"}
        </p>
      </div>
    ),
    { name: "target" },
  ),
  path(
    "/protected",
    () => (
      <div data-testid="auth-redirect-protected">
        <h1 data-testid="auth-redirect-protected-title">
          Auth Redirect Protected
        </h1>
      </div>
    ),
    { name: "protected" },
    () => [
      middleware(async (_ctx, next) => {
        if (!cookies().get("auth-redirect-token")?.value) {
          return redirect("/auth-redirect?rejected=route-mw", 302);
        }
        await next();
      }),
    ],
  ),
]);
