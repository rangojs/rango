import { createLoader } from "@rangojs/router";

/** The server delay of every request: the response comes after the commit. */
const NAV_IDLE_DELAY = 400;

/**
 * #1164 probe loader for /nav-idle and /nav-idle-vt: it reads the search, so
 * a search navigation re-runs it.
 */
export const NavIdleTagsLoader = createLoader(
  async (ctx): Promise<string[]> => {
    await new Promise((resolve) => setTimeout(resolve, NAV_IDLE_DELAY));
    return ctx.searchParams.getAll("tag");
  },
);
