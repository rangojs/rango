import { createLoader } from "@rangojs/router";

// Issue #986 fixture: client-managed paging on a ppr route. /ppr-load-more
// renders the page its URL names; "Load more" appends the next page fetched
// through PprLoadMoreLoader, then soft-navigates to ?page=N.

export function pprLoadMoreItems(page: number): string[] {
  return [1, 2, 3].map((item) => `item-${page}-${item}`);
}

export const PprLoadMoreLoader = createLoader(
  async (ctx): Promise<{ items: string[] }> => ({
    items: pprLoadMoreItems(Number(ctx.params.page ?? "1")),
  }),
  true,
);

// The page the URL names, read on every request (ssr: false bakes it into a
// document shell only). Its data reaches the list in the same commit as the
// navigation's segments, so the list shows page N once ?page=N has rendered.
export const PprLoadMorePageLoader = createLoader(
  async (ctx): Promise<{ page: number }> => ({
    page: Number(ctx.searchParams.get("page") ?? "1"),
  }),
);
