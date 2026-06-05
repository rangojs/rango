import { cookies, type MiddlewareContext } from "@rangojs/router";

// Exported (rather than inlined in urls.tsx) so it can be unit-tested with
// `runMiddleware(setOverlayCookie, "/cookie-overlay")`. The route attaches it
// via `middleware(setOverlayCookie)`.
export async function setOverlayCookie(
  _ctx: MiddlewareContext,
  next: () => Promise<Response>,
): Promise<Response> {
  cookies().set("mw-overlay", "from-middleware", { path: "/" });
  return next();
}
