import { createLoader } from "@rangojs/router";

export interface LoadMorePage {
  page: number;
  items: string[];
}

/**
 * The page `?page=N` names, for the load-more list. `?hold=<ms>` delays every
 * page after the first: the navigation's payload then arrives at once and this
 * loader streams behind it, so React keeps the previous page on screen for
 * that long (#1029). Page 1 is never delayed, so a document load of the start
 * URL can carry the param for the Link to pass on.
 */
export const LoadMoreLoader = createLoader(
  async (ctx): Promise<LoadMorePage> => {
    const page = Number(ctx.searchParams.get("page") ?? "1");
    const hold = Number(ctx.searchParams.get("hold") ?? "0");
    if (hold > 0 && page > 1) {
      await new Promise((resolve) => setTimeout(resolve, hold));
    }
    return { page, items: [1, 2, 3].map((item) => `p${page}-${item}`) };
  },
);
