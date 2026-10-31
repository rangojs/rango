import { createLoader } from "@rangojs/router";

/** The server delay of every request: the response comes after the commit. */
const NAV_IDLE_DELAY = 400;

/**
 * /nav-idle-overlap's hold: long enough for a 300 ms action or a 300 ms
 * redirect to end while React still holds the page.
 */
const NAV_IDLE_OVERLAP_HOLD = 1500;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * #1164 probe loader for /nav-idle and /nav-idle-vt: it reads the search, so
 * a search navigation re-runs it.
 */
export const NavIdleTagsLoader = createLoader(
  async (ctx): Promise<string[]> => {
    await delay(NAV_IDLE_DELAY);
    return ctx.searchParams.getAll("tag");
  },
);

/** /nav-idle-overlap's loader: NavIdleTagsLoader with the longer hold. */
export const NavIdleOverlapTagsLoader = createLoader(
  async (ctx): Promise<string[]> => {
    await delay(NAV_IDLE_OVERLAP_HOLD);
    return ctx.searchParams.getAll("tag");
  },
);
