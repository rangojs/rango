import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  PprSlowMetaHandles,
  makePprSlowMetaParts,
  makePprShortMetaParts,
} from "../loaders/ppr-slow-meta.js";
import { PprSlowMetaView } from "../components/PprSlowMetaView.js";

// Deferred-shell-material layouts (issue #715): three TOP-LEVEL pushes
// settling in parts, the Meta title chained off the slow one. See
// loaders/ppr-slow-meta.ts for the tempo split (slow vs short variant).

/** ~6.5s total settlement — the declared `captureTimeout: 10000` admits it. */
export function PprSlowMetaLayout(ctx: HandlerContext) {
  const parts = makePprSlowMetaParts();
  const pushPart = ctx.use(PprSlowMetaHandles);
  pushPart(parts.immediate);
  pushPart(parts.slow);
  ctx.use(Meta)(parts.chainedTitle.then((title) => ({ title })));
  return (
    <main data-testid="ppr-slow-meta-page">
      <p data-testid="ppr-slow-meta-static">Slow meta static shell</p>
      <PprSlowMetaView />
      <Outlet />
    </main>
  );
}

/**
 * ~3.5s total settlement against an EXPLICIT 1500ms budget: the budget
 * expires with pushes pending, so the capture must REFUSE (stay MISS) — a
 * shell with a partial/missing head snapshot is never stored.
 */
export function PprShortMetaLayout(ctx: HandlerContext) {
  const parts = makePprShortMetaParts();
  const pushPart = ctx.use(PprSlowMetaHandles);
  pushPart(parts.immediate);
  pushPart(parts.slow);
  ctx.use(Meta)(parts.chainedTitle.then((title) => ({ title })));
  return (
    <main data-testid="ppr-short-meta-page">
      <p data-testid="ppr-short-meta-static">Short meta static shell</p>
      <PprSlowMetaView />
      <Outlet />
    </main>
  );
}
