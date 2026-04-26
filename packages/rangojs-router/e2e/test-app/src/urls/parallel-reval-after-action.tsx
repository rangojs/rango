import { urls, loader, revalidate } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { ParallelRevalLoader } from "../loaders.js";
import { ParallelRevalClient } from "../components/ParallelRevalClient.js";
import { RevalidateButton } from "../components/RevalidateButton.js";

/**
 * Regression test for PR #482: parallel slot revalidate() fns must run on
 * sibling-route navigation that follows a server action. Pre-fix, the action
 * pruned @panel from the client's matched set (matchedIds.push was guarded
 * by a 4-condition check that excluded parent-chain parallels), and the next
 * navigation arrived without @panel in _rsc_segments. The resolver then
 * short-circuited with a static decision and never invoked the revalidate
 * fns — the panel rendered as null component instead of refreshing.
 *
 * The fixture mirrors the user-reported scenario:
 *   - Parent layout owns @panel as a parent-chain parallel (not part of any
 *     route — i.e. shared across all sibling routes under this layout).
 *   - @panel has its own loader (returns Date.now()-style fresh count) and
 *     a revalidate() fn that opts out of POST revalidation but allows GET
 *     navigation to refresh.
 *   - Two sibling pages with a server action on page A.
 *
 * Test sequence: nav → click action → nav-to-sibling → assert panel count
 * incremented (proving revalidate fn ran for the sibling nav).
 */
export const parallelRevalAfterActionPatterns = urls(
  ({ path, layout, parallel }) => [
    layout(
      () => (
        <div data-testid="reval-after-action-layout">
          <ParallelOutlet name="@panel" />
          <Outlet />
        </div>
      ),
      () => [
        parallel(
          {
            "@panel": () => (
              <div data-testid="reval-after-action-panel">
                <ParallelRevalClient />
              </div>
            ),
          },
          () => [
            // Loader on the parallel slot. revalidate(() => true) ensures
            // the loader re-runs whenever the slot's revalidate decision is
            // true — without it, the loader caches and we couldn't observe
            // whether the slot's own revalidate fn ran.
            loader(ParallelRevalLoader, () => [revalidate(() => true)]),
            // The exact shape that triggered the bug: opt out of POST
            // revalidation, opt in to GET nav. Pre-fix this fn was never
            // invoked when @panel was missing from clientSegmentIds after
            // a sibling action pruned it — so even an explicit `true`
            // return was silently ignored.
            revalidate(({ method }) => {
              if (method === "POST") return false;
              return true;
            }),
          ],
        ),
      ],
    ),

    path(
      "/parallel-reval-after-action/page-a",
      () => (
        <div data-testid="reval-after-action-page-a">
          <h1>Page A</h1>
          <RevalidateButton testId="reval-after-action-trigger" />
          <Link
            to="/parallel-reval-after-action/page-b"
            data-testid="reval-after-action-link-to-b"
          >
            Go to Page B
          </Link>
        </div>
      ),
      { name: "revalAfterActionPageA" },
    ),

    path(
      "/parallel-reval-after-action/page-b",
      () => (
        <div data-testid="reval-after-action-page-b">
          <h1>Page B</h1>
          <Link
            to="/parallel-reval-after-action/page-a"
            data-testid="reval-after-action-link-to-a"
          >
            Go to Page A
          </Link>
        </div>
      ),
      { name: "revalAfterActionPageB" },
    ),
  ],
);
