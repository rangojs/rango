import type { ReactNode } from "react";
import { preload } from "react-dom";
import { urls } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

// A page that preloads an image it does not render yet, linked from /home
// with a viewport prefetch: the prefetch holds the image's preload and the
// click that uses it starts it. The image is served by the test's route
// handler. Body: tests/shared-e2e/src/prefetch-preloads-scenario.ts.

const BASE = "/prefetch-preloads";

// React emits a hint only from a component Flight renders, not from the
// handler call itself.
function Target(): ReactNode {
  preload(`${BASE}/hero.svg`, { as: "image", fetchPriority: "high" });
  // Kept, so it starts during the prefetch, after the hero's row.
  preload(`${BASE}/kept.css`, { as: "style" });
  return <p data-testid="pp-target">target</p>;
}

export const prefetchPreloadsPatterns = urls(({ layout, path }) => [
  layout(
    () => (
      <div>
        <Link
          to={`${BASE}/target`}
          prefetch="viewport"
          data-testid="pp-to-target"
        >
          target
        </Link>
        <Outlet />
      </div>
    ),
    () => [
      path("/home", () => <p data-testid="pp-home">home</p>, {
        name: "home",
      }),
      path("/target", () => <Target />, { name: "target" }),
    ],
  ),
]);
