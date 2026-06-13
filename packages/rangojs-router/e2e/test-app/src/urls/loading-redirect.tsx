import { urls, redirect } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

// redirect() from a loading() route (M9).
//
// A synchronous handler return of redirect() on a loading() route short-circuits
// to a real HTTP redirect before the streamed loading() boundary takes over.
// (An async return of a Response is streamed instead — a documented limitation
// that dev warns about via warnOnStreamedResponse; it produces a degraded render,
// not a navigable outcome, so it is covered by the unit test, not e2e.)
export const loadingRedirectPatterns = urls(({ path, loading }) => [
  // Index with a soft-nav Link, so the client navigation path is exercised too.
  path(
    "/",
    () => (
      <div data-testid="lr-index">
        <Link to="/loading-redirect/sync" data-testid="lr-link">
          go sync
        </Link>
      </div>
    ),
    { name: "index" },
  ),
  // Synchronous redirect() return under a loading() boundary.
  path(
    "/sync",
    () => redirect("/loading-redirect/target", 302),
    { name: "sync" },
    () => [loading(<div data-testid="lr-skeleton">Loading...</div>)],
  ),
  path("/target", () => <div data-testid="lr-target">arrived</div>, {
    name: "target",
  }),
]);
