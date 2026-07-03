import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { PprShellPriceLoader } from "../loaders/ppr-shell.js";
import { PprShellPrice } from "../components/PprShellPrice.js";

// Capture-data-snapshot DRIFT fixture (docs/design/ppr-shell-resume.md), on the
// REAL KV-backed CFCacheStore that this app uses. A value baked into the PPR
// shell (above loading(), so it is prelude material) via the "drift" cache
// profile — ttl 2s, swr 0, so the underlying entry is fully GONE two seconds
// after capture (short-ttl items live only in the L1 Cache API tier; KV skips
// sub-60s writes). Every fresh execution returns a DISTINCT stamp, so a HIT after
// expiry would recompute a different value and drift from the frozen prelude —
// the hydration hazard the capture data snapshot pins. ctx is a tainted key arg,
// so the cache key is scoped per-URL (probe isolation).
let driftExecutions = 0;

export async function getPprDriftStamp(ctx: HandlerContext): Promise<string> {
  "use cache: drift";
  void ctx.pathname;
  driftExecutions += 1;
  return `ppr-drift-${driftExecutions}`;
}

// Async server component that awaits the drifting cached stamp; rendered directly
// in the shell layout (above loading()), so its value is baked into the captured
// prelude. On a HIT after the ttl expired the snapshot replays the capture-time
// value, so the fresh hydration payload matches the frozen prelude.
async function PprDriftStamp({ stamp }: { stamp: Promise<string> }) {
  return <p data-testid="ppr-drift-stamp">{await stamp}</p>;
}

// Drift layout: baked (shell) drift stamp + the live price hole via the page's
// Outlet. The stamp drifts once its short-ttl cache entry expires; the price
// loader stays a live hole (seq advances every request).
export function PprDriftLayout(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "PPR Drift - RSC Router Cloudflare" });
  const stamp = getPprDriftStamp(ctx);
  return (
    <main data-testid="ppr-drift-page">
      <h1 data-testid="ppr-drift-header">PPR Drift Demo</h1>
      <PprDriftStamp stamp={stamp} />
      <Outlet />
    </main>
  );
}

export function PprDriftPricePage() {
  return <PprShellPrice loader={PprShellPriceLoader} />;
}
