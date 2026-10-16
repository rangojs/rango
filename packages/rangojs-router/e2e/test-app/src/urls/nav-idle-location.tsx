import {
  urls,
  createLoader,
  redirect,
  type Handler,
  type Revalidate,
} from "@rangojs/router";
import { NavIdleFilters } from "../components/NavIdleFilters.js";
import {
  NavIdleOverlapControls,
  NavIdleServerTags,
} from "../components/NavIdleOverlapControls.js";

/** The server delay of every request: the response comes after the commit. */
const NAV_IDLE_DELAY = 400;

/**
 * /nav-idle-overlap's hold: long enough for a 300 ms action or a 300 ms
 * redirect to end while React still holds the page.
 */
const NAV_IDLE_OVERLAP_HOLD = 1500;

/** Where /nav-idle-overlap?away sends the browser (the e2e answers it 204). */
const NAV_IDLE_EXTERNAL = "https://nav-idle-external.example/";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads the search, so a search navigation re-runs it. */
export const NavIdleTagsLoader = createLoader(async (ctx) => {
  await delay(NAV_IDLE_DELAY);
  return ctx.searchParams.getAll("tag");
});

export const NavIdleOverlapTagsLoader = createLoader(async (ctx) => {
  await delay(NAV_IDLE_OVERLAP_HOLD);
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

const NavIdleOverlapPage: Handler = () => (
  <div data-testid="nav-idle-page">
    <NavIdleServerTags loader={NavIdleOverlapTagsLoader} />
    <NavIdleFilters />
    <NavIdleOverlapControls away="/nav-idle-overlap?away=1" />
  </div>
);

/** The action re-renders nothing, so its answer does not wait on the hold. */
const skipOnAction: Revalidate = (ctx) => (ctx.isAction() ? false : undefined);

/**
 * #1164: useNavigation() idle commits with the location on a same-route
 * search navigation. One page, twice: /nav-idle commits through the
 * same-structure hold (no transition()), /nav-idle-vt through transition()
 * (a view transition where the browser has one). /nav-idle-overlap holds the
 * page for 1.5 s, while an action settles or a newer navigation ends with no
 * page (?away answers with an external redirect after 300 ms).
 */
export const navIdleLocationPatterns = urls(
  ({ path, loader, transition, middleware, revalidate }) => [
    path("/nav-idle", NavIdlePage, { name: "navIdle" }, () => [
      loader(NavIdleTagsLoader),
    ]),
    path("/nav-idle-vt", NavIdlePage, { name: "navIdleVt" }, () => [
      loader(NavIdleTagsLoader),
      transition(),
    ]),
    path(
      "/nav-idle-overlap",
      NavIdleOverlapPage,
      { name: "navIdleOverlap" },
      () => [
        middleware(async (ctx, next) => {
          if (!ctx.searchParams.has("away")) return next();
          await delay(300);
          return redirect(NAV_IDLE_EXTERNAL, { external: true });
        }),
        loader(NavIdleOverlapTagsLoader, () => [revalidate(skipOnAction)]),
        revalidate(skipOnAction),
        transition(),
      ],
    ),
  ],
);
