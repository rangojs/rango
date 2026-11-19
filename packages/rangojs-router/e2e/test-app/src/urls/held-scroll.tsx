import { urls, revalidate } from "@rangojs/router";
import { HeldScrollNav } from "./held-scroll.client.js";

/**
 * A page whose navigations to itself hold every segment: the route never
 * revalidates and the layouts above it have no loaders, so the answer has
 * nothing to redraw (e2e/held-navigation-scroll.test.ts). The nav is fixed,
 * so a click on it does not scroll the page; the page is tall enough to
 * scroll, with a hash target part-way down. `held-scroll-render` changes only
 * when the route renders.
 */
export const heldScrollPatterns = urls(({ path }) => [
  path(
    "/held-scroll",
    () => (
      <div
        data-testid="held-scroll-page"
        style={{ position: "relative", minHeight: "6000px" }}
      >
        <span data-testid="held-scroll-render">{crypto.randomUUID()}</span>
        <HeldScrollNav />
        <section
          id="held-scroll-target"
          data-testid="held-scroll-target"
          style={{ position: "absolute", top: "3000px" }}
        >
          target
        </section>
      </div>
    ),
    { name: "heldScroll" },
    () => [revalidate(() => false)],
  ),
]);
