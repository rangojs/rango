import {
  redirect,
  type Handler,
  type Middleware,
  type Revalidate,
} from "@rangojs/router";
import {
  NavIdleOverlapTagsLoader,
  NavIdleTagsLoader,
} from "../loaders/nav-idle.js";
import { NavIdleFilters } from "../components/NavIdleFilters.js";
import { NavIdleStatus } from "../components/NavIdleStatus.js";
import {
  NavIdleOverlapControls,
  NavIdleServerTags,
} from "../components/NavIdleOverlapControls.js";

/** Where /nav-idle-overlap?away sends the browser (the e2e answers it 204). */
const NAV_IDLE_EXTERNAL = "https://nav-idle-external.example/";

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

/**
 * /nav-idle-overlap: the page is held for 1.5 s, while an action settles or
 * a newer navigation ends with no page (navIdleOverlapAway).
 */
export const NavIdleOverlapPage: Handler = () => (
  <div data-testid="nav-idle-page">
    <NavIdleServerTags loader={NavIdleOverlapTagsLoader} />
    <NavIdleFilters />
    <NavIdleOverlapControls away="/nav-idle-overlap?away=1" />
  </div>
);

/** ?away answers with an external redirect after 300 ms. */
export const navIdleOverlapAway: Middleware = async (ctx, next) => {
  if (!ctx.searchParams.has("away")) return next();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return redirect(NAV_IDLE_EXTERNAL, { external: true });
};

/** The action re-renders nothing, so its answer does not wait on the hold. */
export const navIdleSkipOnAction: Revalidate = (ctx) =>
  ctx.isAction() ? false : undefined;
