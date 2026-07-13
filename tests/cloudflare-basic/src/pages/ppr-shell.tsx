import { Suspense } from "react";
import { Meta, Prerender, Passthrough } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { PprShellPriceLoader } from "../loaders/ppr-shell.js";
import { PprShellStreamLoader } from "../loaders/ppr-shell.js";
import { PprShellSettledLoader } from "../loaders/ppr-shell.js";
import { PprShellExecLoader, pprExecCounters } from "../loaders/ppr-shell.js";
import { PprPrerenderSeqLoader } from "../loaders/ppr-shell.js";
import { PprInlineActionHoleLoader } from "../loaders/ppr-shell.js";
import { PprBakeSlowLoader, PprBakeHoleLoader } from "../loaders/ppr-shell.js";
import { makePprPhysicsPromise } from "../loaders/ppr-shell.js";
import {
  makePprStaleReplayData,
  PprStaleReplayHandle,
} from "../loaders/ppr-shell.js";
import { PprShellPrice } from "../components/PprShellPrice.js";
import { PprShellStream } from "../components/PprShellStream.js";
import { PprShellSettled } from "../components/PprShellSettled.js";
import { PprBakeSlow } from "../components/PprBakeSlow.js";
import { PprShellCounter } from "../components/PprShellCounter.js";
import { PprShellPhysicsValue } from "../components/PprShellPhysicsValue.js";
import {
  PprInlineActionForm,
  PprPrerenderActionForm,
  PprShellExecMatrix,
  type PprInlineActionState,
} from "../components/PprShellExecMatrix.js";
import { PprPrerenderSeq } from "../components/PprPrerenderSeq.js";
import { PprStaleReplay } from "../components/PprStaleReplay.js";

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

export function PprStaleReplayPage(ctx: HandlerContext<{ id: string }>) {
  const id = ctx.params.id;
  const data = makePprStaleReplayData(id);
  const push = ctx.use(PprStaleReplayHandle);
  push({ yo: `yo-${id}` });
  push(data.then((value) => ({ asd: value })));
  ctx.use(Meta)(
    data.then(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { title: `Stale replay ${id}: ${value}` };
    }),
  );

  return (
    <Suspense fallback={<div>Loading stale replay {id}...</div>}>
      <PprStaleReplay
        data={data}
        handle={PprStaleReplayHandle}
        search={ctx.url.search}
      />
    </Suspense>
  );
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

// Pin-first bake-lane layout (loader-cache.ts `if (!recorded.holes)`), the
// workerd/KV counterpart of test-app's ShellBakeSlowLayout. Registers
// PprBakeSlowLoader — 600ms, NO loading() on the layout, so the BAKE lane (see
// urls.tsx). Its plain hole-free container bakes into the shell snapshot's
// loader family; on a HIT the record is hole-free, so the payload resolves the
// loaderData from the PIN immediately rather than gating on the slow fresh run.
// The child ppr route keeps a fast ~30ms price hole behind loading() so a real
// shell captures.
export function PprBakeSlowLayout() {
  return (
    <main data-testid="ppr-bake-slow-page">
      <p data-testid="ppr-bake-chrome">Bake slow static chrome</p>
      <Outlet />
    </main>
  );
}

export function PprBakeSlowPage() {
  return (
    <PprBakeSlow
      bakeLoader={PprBakeSlowLoader}
      holeLoader={PprBakeHoleLoader}
    />
  );
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

// Storefront shape (PPR navigation replay composed with an explicit cache()):
// static layout chrome; the page embeds a per-execution stamp so a replayed
// serve (frozen stamp) is distinguishable from a fresh handler run.
export function PprScopedChromeLayout() {
  return (
    <main data-testid="ppr-scoped-page">
      <p data-testid="ppr-scoped-chrome">Scoped chrome static content</p>
      <Outlet />
    </main>
  );
}

let pprScopedExecution = 0;

export function PprScopedHomePage() {
  pprScopedExecution += 1;
  return (
    <p data-testid="ppr-scoped-home">
      scoped-home-execution-{pprScopedExecution}
    </p>
  );
}

export function PprScopedOptOutPage() {
  return <p data-testid="ppr-scoped-optout">Scoped opt-out static content</p>;
}

export function PprScopedConditionPage() {
  return (
    <p data-testid="ppr-scoped-condition">Scoped condition static content</p>
  );
}

// Shell fast-path execution matrix (docs/design/shell-fast-path.md): each
// layer increments its module counter; the DSL loader (live lane) reports the
// snapshot per serve. On a fast-path HIT, ONLY middleware + the loader may
// advance — the three handler counters are pinned frozen by the e2e (handlers
// are replayed from the captured doc segment record, never executed).
export function PprExecLayout() {
  pprExecCounters.layout += 1;
  return (
    <main data-testid="ppr-exec-page">
      <p data-testid="ppr-exec-chrome">Exec matrix static chrome</p>
      <ParallelOutlet name="@pprExecBadge" />
      <Outlet />
    </main>
  );
}

export function PprExecBadgeSlot() {
  pprExecCounters.parallel += 1;
  return <span data-testid="ppr-exec-badge">exec badge</span>;
}

export function PprExecPage() {
  pprExecCounters.path += 1;
  return <PprShellExecMatrix loader={PprShellExecLoader} />;
}

export function PprInlineActionPage() {
  const captured = `cf-server-token-${crypto.randomUUID()}`;
  async function submit(
    _previous: PprInlineActionState,
    formData: FormData,
  ): Promise<PprInlineActionState> {
    "use server";
    const submitted = String(formData.get("value"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      captured,
      submitted,
      streamed: new Promise((resolve) =>
        setTimeout(() => resolve(`completed:${captured}:${submitted}`), 1_200),
      ),
    };
  }

  return (
    <PprInlineActionForm
      action={submit}
      renderedCaptured={captured}
      pageHoleLoader={PprInlineActionHoleLoader}
    />
  );
}

// Prerender + ppr composition (docs/design/shell-fast-path.md): build-time
// segments — the article content AND the slot handler element — bake into the
// frozen prelude; the SLOT-owned loader (loader()+loading() on @ppSeq, the
// slot-hole playbook) masks at capture and re-runs fresh per HIT. The
// Prerender handler never executes at serve (production evicts it to a stub).
export const PprPrerenderedArticle = Prerender(
  // "warm" is the e2e warm-up slug: the suite's beforeAll polls its bare path
  // to HIT so producer B's machinery (dev: the /__rsc_shell on-demand capture
  // graph on the temp Node server) is hot before the strict first-request
  // assertions run on the virgin alpha/beta bare paths.
  async () => [{ slug: "alpha" }, { slug: "beta" }, { slug: "warm" }],
  async (ctx) => {
    return (
      <div data-testid="ppr-pp-article">
        <h1 data-testid="ppr-pp-article-title">{`PPR-PP ${ctx.params.slug}`}</h1>
        <p data-testid="ppr-pp-article-content">
          {`Prerendered shell content for ${ctx.params.slug}`}
        </p>
        <ParallelOutlet name="@ppSeq" />
      </div>
    );
  },
);

/**
 * Passthrough + Prerender + ppr fixture for the replay gate's existence
 * probe on the real CFCacheStore/KV path: only "baked" bakes at build time;
 * every other slug misses the prerender store and renders LIVE through the
 * Passthrough handler. The trie still marks the route pr:true, so the gate
 * must probe the store instead of trusting the flag — live params keep
 * navigation replay (their captures record the doc segment record), baked
 * params keep the prerender-store bypass.
 */
let pprPpPassthroughExec = 0;

export const PprPrerenderedPassthroughDef = Prerender<{ slug: string }>(
  async () => [{ slug: "baked" }],
  async (ctx) => (
    <div data-testid="ppr-ppp-article">
      <p data-testid="ppr-ppp-source">baked</p>
      <p data-testid="ppr-ppp-content">{`PPR-PPP content for ${ctx.params.slug}`}</p>
      <PprPrerenderActionForm />
    </div>
  ),
);

export const PprPrerenderedPassthroughArticle = Passthrough(
  PprPrerenderedPassthroughDef,
  async (ctx) => {
    pprPpPassthroughExec += 1;
    return (
      <div data-testid="ppr-ppp-article">
        <p data-testid="ppr-ppp-source">live</p>
        <p data-testid="ppr-ppp-content">{`PPR-PPP content for ${ctx.params.slug}`}</p>
        <p data-testid="ppr-ppp-exec">{`ppr-ppp-exec-${pprPpPassthroughExec}`}</p>
        <PprPrerenderActionForm />
      </div>
    );
  },
);

/**
 * Dedicated fixture for the build-shell EVICTION e2e (#699): its own route +
 * tag so updateTag("ppr-pp-evict-shell") cannot blast the sibling
 * /ppr-shell/prerendered/:slug entries a concurrently-running test asserts on
 * (dev runs fullyParallel). Same slot-hole shape as PprPrerenderedArticle.
 */
export const PprPrerenderedEvictArticle = Prerender(
  async () => [{ slug: "gamma" }],
  async (ctx) => {
    return (
      <div data-testid="ppr-pp-evict-article">
        <p data-testid="ppr-pp-evict-article-content">
          {`Evictable shell content for ${ctx.params.slug}`}
        </p>
        <ParallelOutlet name="@ppSeq" />
      </div>
    );
  },
);

export function PprPrerenderSeqSlot() {
  return <PprPrerenderSeq loader={PprPrerenderSeqLoader} />;
}
