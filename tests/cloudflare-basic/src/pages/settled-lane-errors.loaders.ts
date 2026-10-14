import { createLoader, redirect } from "@rangojs/router";
import {
  isSettledLaneBroken,
  nextSettledLaneRun,
} from "./settled-lane-errors.state.js";

// Loaders a fully-prefetched click and a back/forward restore commit settled
// (e2e/settled-lane-errors.test.ts): one that always throws, one that always
// throws redirect() to a sibling route under the same layout, and one that
// throws once its run's switch is on (the background refresh after Back) or,
// with `?once`, on its run's first call only (a prefetch, then the click).
export const SettledLaneFailLoader = createLoader(
  async (): Promise<{ value: string }> => {
    throw new Error("stock service unavailable");
  },
);

export const SettledLaneGoneLoader = createLoader(
  async (): Promise<{ name: string }> => {
    throw redirect("/settled-lane-errors/ok");
  },
);

export const SettledLaneFlakyLoader = createLoader(
  async (ctx): Promise<{ value: string }> => {
    // A `?once` call counts on its own, so no other request moves it.
    const once = ctx.searchParams.has("once");
    const run = `${ctx.searchParams.get("run") ?? "none"}${once ? ":once" : ""}`;
    const n = nextSettledLaneRun(run);
    if (isSettledLaneBroken(run) || (once && n === 1)) {
      throw new Error("stock service unavailable");
    }
    return { value: `stock:${n}` };
  },
);
