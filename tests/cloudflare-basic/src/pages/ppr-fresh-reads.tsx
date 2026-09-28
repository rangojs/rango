// Issue #941 fixture: a PPR shell tagged per probe (render-callable cacheTag)
// with a render token, and a button whose server action runs updateTag() on
// that tag. The e2e checks the action's fresh-reads cookie, that the reload is
// fresh, and that the next HITs carrying the cookie read past the isolate
// memos while a request without it is served from them.

import type { HandlerContext } from "@rangojs/router";
import { cacheTag } from "@rangojs/router";
import { FreshReadsButton } from "../components/FreshReadsButton.js";
import { freshReadsTag } from "./ppr-fresh-reads-tag.js";

export function PprFreshReadsPage(ctx: HandlerContext) {
  const probe = ctx.searchParams.get("probe") ?? "none";
  cacheTag(freshReadsTag(probe));
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <main data-testid="ppr-fresh-reads">
      <p data-testid="fresh-reads-token">{token}</p>
      <FreshReadsButton probe={probe} />
    </main>
  );
}
