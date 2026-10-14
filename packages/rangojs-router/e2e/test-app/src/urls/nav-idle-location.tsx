import { urls, createLoader, type Handler } from "@rangojs/router";
import { NavIdleFilters } from "../components/NavIdleFilters.js";

/** The server delay of every request: the response comes after the commit. */
const NAV_IDLE_DELAY = 400;

/** Reads the search, so a search navigation re-runs it. */
export const NavIdleTagsLoader = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, NAV_IDLE_DELAY));
  return ctx.searchParams.getAll("tag");
});

const NavIdlePage: Handler = async (ctx) => {
  const tags = await ctx.use(NavIdleTagsLoader);
  return (
    <div data-testid="nav-idle-page">
      <p data-testid="nav-idle-server-tags">{tags.join(",") || "none"}</p>
      <NavIdleFilters />
    </div>
  );
};

/**
 * #1164: useNavigation() idle commits with the location on a same-route
 * search navigation. One page, twice: /nav-idle commits through the
 * same-structure hold (no transition()), /nav-idle-vt through transition()
 * (a view transition where the browser has one).
 */
export const navIdleLocationPatterns = urls(({ path, loader, transition }) => [
  path("/nav-idle", NavIdlePage, { name: "navIdle" }, () => [
    loader(NavIdleTagsLoader),
  ]),
  path("/nav-idle-vt", NavIdlePage, { name: "navIdleVt" }, () => [
    loader(NavIdleTagsLoader),
    transition(),
  ]),
]);
