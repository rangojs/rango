import { urls } from "@rangojs/router";
import { Suspense } from "react";
import { Link } from "@rangojs/router/client";
import {
  StatsCard,
  ActivityCard,
  ReportCard,
  CardSkeleton,
} from "../components/SuspenseDemoCards.js";
import {
  FastStatsLoader,
  MediumActivityLoader,
  SlowReportLoader,
} from "../loaders/suspense-demo.js";

/**
 * Streaming useLoader demo (feat/useloader-suspense).
 *
 * "/" — NO loading() on the route. Previously this shape BLOCKED the tree
 * build until every loader resolved (2s TTFB gated on the slowest). Now the
 * shell streams immediately and each card's useLoader suspends to its OWN
 * Suspense boundary: stats ~400ms, activity ~1200ms, report ~2000ms.
 *
 * "/gated" — the classic loading() route for contrast. The route-level
 * fallback covers everything until the UNWRAPPED read (stats, 400ms)
 * resolves; the wrapped slow report keeps filling independently behind its
 * local skeleton at 2000ms. loading() is plain JSX deliberately: a client-component
 * fallback that suspends cold is a known SSR-emission divergence on this
 * branch.
 */

function SuspenseDemoIndexPage() {
  return (
    <div data-testid="suspense-demo-page">
      <h1 data-testid="sd-hero">Streaming useLoader demo</h1>
      <p>
        This route has <strong>no loading()</strong> and three loaders (400ms /
        1200ms / 2000ms). The heading paints immediately; each card suspends on
        its own read and fills in when its loader's data streams in.
      </p>
      <Suspense fallback={<CardSkeleton label="stats" />}>
        <StatsCard />
      </Suspense>
      <Suspense fallback={<CardSkeleton label="activity" />}>
        <ActivityCard />
      </Suspense>
      <Suspense fallback={<CardSkeleton label="report" />}>
        <ReportCard />
      </Suspense>
      <p>
        <Link to="/suspense-demo/gated" data-testid="sd-to-gated">
          Compare: same loaders behind route-level loading()
        </Link>
      </p>
    </div>
  );
}

function SuspenseDemoGatedPage() {
  return (
    <div data-testid="suspense-demo-gated-page">
      <h1 data-testid="sd-gated-hero">Gated variant</h1>
      <p>
        This route has <strong>loading()</strong>. The route fallback holds the
        whole page until the unwrapped stats read (400ms) resolves — then the
        page reveals while the wrapped report keeps its local skeleton until
        2000ms.
      </p>
      {/* Unwrapped read: suspends to the route's loading() boundary. */}
      <StatsCard />
      <Suspense fallback={<CardSkeleton label="report" />}>
        <ReportCard />
      </Suspense>
      <p>
        <Link to="/suspense-demo" data-testid="sd-to-index">
          Back to the streaming variant
        </Link>
      </p>
    </div>
  );
}

export const suspenseDemoPatterns = urls(({ path, loader, loading }) => [
  path("/", SuspenseDemoIndexPage, { name: "index" }, () => [
    loader(FastStatsLoader),
    loader(MediumActivityLoader),
    loader(SlowReportLoader),
  ]),
  path("/gated", SuspenseDemoGatedPage, { name: "gated" }, () => [
    loader(FastStatsLoader),
    loader(SlowReportLoader),
    loading(<div data-testid="sd-gated-fallback">Loading the gated page…</div>),
  ]),
]);
