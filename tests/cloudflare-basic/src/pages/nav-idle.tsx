import type { Handler } from "@rangojs/router";
import { NavIdleTagsLoader } from "../loaders/nav-idle.js";
import { NavIdleFilters } from "../components/NavIdleFilters.js";
import { NavIdleStatus } from "../components/NavIdleStatus.js";

/**
 * #1164: useNavigation() idle commits with the location on a same-route
 * search navigation. Mounted twice: /nav-idle commits through the
 * same-structure hold (no transition()), /nav-idle-vt through transition()
 * (a view transition where the browser has one).
 */
export const NavIdlePage: Handler = async (ctx) => {
  const tags = await ctx.use(NavIdleTagsLoader);
  return (
    <div data-testid="nav-idle-page">
      <p data-testid="nav-idle-server-tags">{tags.join(",") || "none"}</p>
      <NavIdleFilters />
      <NavIdleStatus />
    </div>
  );
};
