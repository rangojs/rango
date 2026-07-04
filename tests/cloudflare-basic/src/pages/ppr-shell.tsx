import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { PprShellPriceLoader } from "../loaders/ppr-shell.js";
import { PprShellStreamLoader } from "../loaders/ppr-shell.js";
import { PprShellSettledLoader } from "../loaders/ppr-shell.js";
import { makePprPhysicsPromise } from "../loaders/ppr-shell.js";
import { PprShellPrice } from "../components/PprShellPrice.js";
import { PprShellStream } from "../components/PprShellStream.js";
import { PprShellSettled } from "../components/PprShellSettled.js";
import { PprShellCounter } from "../components/PprShellCounter.js";
import { PprShellPhysicsValue } from "../components/PprShellPhysicsValue.js";

// PPR shell caching demo (docs/design/ppr-shell-resume.md).
//
// The hole/shell split follows the router's PPR eligibility contract: a hole
// exists only where a Suspense boundary separates loader consumption from the
// shell, and the route-level loading() DSL is that boundary (LoaderBoundary
// use()es the loader promise INSIDE its own Suspense). A loader route WITHOUT
// loading() awaits its loader data at tree-build (renderSegments' loading-less
// branch), so under capture's masked loaders the whole tree pends, the prelude
// comes back trivial, and the sanity gate refuses to store — the shell never
// HITs. This route was first written in that mis-shape (hand-rolled <Suspense>
// + useLoader, no loading()).
//
// So the SHELL material lives in PprShellLayout — static text, a handle read
// (Breadcrumbs, rendered by NavLayout), and an interactive client island
// (PprShellCounter) — all deterministic, so the cached prelude and the fresh
// hydration payload agree (no drift, no hydration errors). The route content is
// ONLY the live hole: PprShellPrice behind loading(). On the first GET the
// shell cache captures the shell in the background (masked loader ->
// LoaderBoundary postpones -> prelude = layout + "Loading price..." fallback);
// a later GET is served x-rango-shell: HIT with the frozen prelude flushed
// immediately and the live price resumed into it after the ~400ms loader.
export function PprShellLayout(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "PPR Shell - RSC Router Cloudflare" });

  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: "/" });
  breadcrumb({ label: "PPR Shell", href: "/ppr-shell" });
  return (
    <main data-testid="ppr-shell-page">
      <h1 data-testid="ppr-shell-header">PPR Shell Demo</h1>
      <p data-testid="ppr-shell-static">
        This static shell content is frozen into the cached prelude.
      </p>
      <PprShellCounter />
      <PprShellPhysicsValue promise={makePprPhysicsPromise()} />
      <Outlet />
      <nav>
        <Link to="/counter" data-testid="ppr-nav-counter">
          Go to Counter
        </Link>
      </nav>
    </main>
  );
}

export function PprShellPricePage() {
  return <PprShellPrice loader={PprShellPriceLoader} />;
}

// Loader-carried-promise page, reused by BOTH /ppr-shell/stream (WITH loading(),
// so the loader is a PPR hole) and /ppr-shell/no-hole (NO loading(), so capture
// refuses and the route stays MISS forever while the inner promise still
// streams). The page component is identical for both — the ONLY difference is
// whether the route carries loading() (see urls.tsx).
export function PprShellStreamPage() {
  return <PprShellStream loader={PprShellStreamLoader} />;
}

// Settled-marker regression page (storefront PDP #438): bake-lane loader whose
// nested promise is already resolved at container return — the snapshot pins
// its value; the HIT overlay must rehydrate a Promise for use().
export function PprShellSettledPage() {
  return <PprShellSettled loader={PprShellSettledLoader} />;
}

// LAYOUT-LOADER bake-lane layout (the storefront shape): registers
// PprChromeLoader with NO loading() on the LAYOUT (see urls.tsx) — the BAKE
// lane. The loader executes at capture, its container bakes, and both
// children HIT. Consumed by nothing — the lane decision is registration-level.
export function PprTrapChromeLayout() {
  return (
    <main data-testid="ppr-trap-page">
      <p data-testid="ppr-trap-chrome">Trap chrome static text</p>
      <Outlet />
    </main>
  );
}

export function PprBareHomePage() {
  return <p data-testid="ppr-bare-home">Bare home static content</p>;
}

// LIVE-lane alternative (skills/ppr "layout-with-loaders playbook"): the same
// chrome data owned by a @badge parallel slot with its OWN loading() — a
// badge-sized GUARANTEED-fresh hole (the bake lane would pin the value for the
// shell's lifetime). Chrome and the static page bake; the route needs no
// loader or loading() of its own.
export function PprSlotChromeLayout() {
  return (
    <main data-testid="ppr-slot-page">
      <p data-testid="ppr-slot-chrome">Slot chrome static text</p>
      <ParallelOutlet name="@badge" />
      <Outlet />
    </main>
  );
}

export function PprSlotHomePage() {
  return <p data-testid="ppr-slot-home">Slot home static content</p>;
}
