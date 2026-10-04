import type { HandlerContext } from "@rangojs/router";
import { PprLoadMoreList } from "../components/PprLoadMoreList.js";
import { pprLoadMoreItems } from "../loaders/ppr-load-more.js";

// Issue #986: renders the page its URL names. Keyed by that page, so a server
// render of another page starts a new list instead of merging into this one.
export function PprLoadMorePage(ctx: HandlerContext) {
  const page = Number(ctx.url.searchParams.get("page") ?? "1");
  return (
    <PprLoadMoreList key={page} page={page} items={pprLoadMoreItems(page)} />
  );
}
