import { urls, Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  ShellActionCounterLoader,
  getShellActionBanner,
  getLastPeSubmit,
} from "./shell-cache-action.defs.js";
import { ShellActionHole } from "../components/ShellActionHole.js";
import { ShellActionBannerButton } from "../components/ShellActionBannerButton.js";
import { incrementHolePeAction } from "../actions/shell-cache-action.js";

// PPR action-correctness fixtures (Deliverable 10). The shell-cache middleware is
// wired path-scoped in router.tsx onto /shell-cache-action/*. The layout holds the
// SHELL material (a cached+tagged banner, frozen into the prelude); the route
// content is the live HOLE (a loader behind loading()) plus action surfaces:
//   - 10(a) JS action mutating the HOLE (loader-fed) value;
//   - 10(b) JS action mutating SHELL material + updateTag() (drops the tagged shell);
//   - 10(c) a no-JS PE form POST (native form action) into the PPR route.

async function ShellActionLayout(ctx: HandlerContext) {
  ctx.use(Meta)({ title: "Shell Cache Action" });
  // Cached + tagged shell material — frozen into the prelude and carrying the tag.
  const banner = await getShellActionBanner();
  return (
    <main data-testid="shell-action-page">
      <h1 data-testid="shell-action-header">Shell Cache Action Demo</h1>
      <p data-testid="shell-action-banner">{banner}</p>
      <ShellActionBannerButton />
      <Outlet />
    </main>
  );
}

function ShellActionHolePage() {
  return <ShellActionHole loader={ShellActionCounterLoader} />;
}

// 10(c) PE route — SEPARATE from the JS-action route above. A native
// `<form action={serverAction}>` in a FROZEN shell drifts on hydration (React
// encodes server-action form fields differently between the capture and the serve
// render — a documented PPR shell caveat), so it must not sit in a shell the JS
// tests hydrate. This route is only ever exercised no-JS (the PE test), where
// nothing hydrates, so the native form + its SHELL-visible result are safe here.
// The form + result live in the shell (not a loading() hole) so they render without
// JS — a Suspense-holed value would sit in a hidden <template> the $RC reveal (JS)
// never swaps. Covered by the same /shell-cache-action/* middleware.
function ShellPePage(ctx: HandlerContext) {
  ctx.use(Meta)({ title: "Shell Cache PE" });
  return (
    <main data-testid="shell-pe-page">
      <h1 data-testid="shell-pe-header">Shell Cache PE Demo</h1>
      <p data-testid="shell-action-pe-result">{getLastPeSubmit()}</p>
      <form
        action={incrementHolePeAction}
        method="post"
        data-testid="shell-action-pe-form"
      >
        <button type="submit" data-testid="shell-action-pe-submit">
          PE Increment
        </button>
      </form>
    </main>
  );
}

export const shellCacheActionPatterns = urls(
  ({ path, layout, loader, loading }) => [
    layout(ShellActionLayout, () => [
      // The ppr path option opts the route in. The banner is a tagged "use cache"
      // read executed by the capture render (mixed-chain: uncached segments run
      // fresh), and its cacheTag lands in the capture's request tags, so the shell
      // AUTO-carries SHELL_ACTION_BANNER_TAG — updateTag() in the 10(b) action
      // drops the shell (and the ring-1 value), and the recapture re-reads the
      // fresh banner.
      path(
        "/shell-cache-action",
        ShellActionHolePage,
        { name: "shellCacheAction", ppr: { ttl: 300, swr: 120 } },
        () => [
          loader(ShellActionCounterLoader),
          loading(
            <div data-testid="shell-action-fallback">Loading count...</div>,
          ),
        ],
      ),
    ]),
    // 10(c) PE route stays axis 1 (no ppr): a native server-action form is not a
    // shell candidate and is only ever exercised no-JS.
    path("/shell-cache-action/pe", ShellPePage, { name: "shellCacheActionPe" }),
  ],
);
