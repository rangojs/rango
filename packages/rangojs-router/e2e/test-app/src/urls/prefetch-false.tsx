import { Suspense, ViewTransition } from "react";
import {
  urls,
  createLoader,
  notFound,
  Prerender,
  redirect,
} from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import {
  PrefetchFalseCounts,
  PrefetchFalseScroll,
} from "../components/PrefetchFalseCounts.js";
import { PrefetchFalseNotes } from "../components/PrefetchFalseNotes.js";
import {
  PrefetchFalseNav,
  PrefetchFalseValue,
} from "../components/PrefetchFalseValue.js";
import { PfNotes } from "./prefetch-false.handle.js";
import { countRun, readRunCounts } from "../prefetch-false-counts.js";

// `prefetch: false` (docs/design/prefetch-false.md): one page per case, all
// behind one hub layout whose links prefetch on hover only, so a suite decides
// when the prefetch happens. Every unit of work counts its runs under the
// `?run=` of the request (prefetch-false-counts.ts); /__counts reads them
// back. A loader's value is `<counter>:<run number>`.
//
// The contract a suite (and any other app that mirrors this fixture) relies
// on, for each case `<c>`:
//   pf-link-<c>      hub link, prefetch="hover", to /prefetch-false/<c>?run=
//   pf-<c>-page      the handler's content
//   pf-<c>-fallback  what shows while the deferred part is missing
//   pf-<c>-value     the deferred loader's value, counter `<c>.data`
// `loader` also has pf-loader-price (an unflagged loader, counter
// `loader.price`). `unit`, `cached`, `section` and `slot` count their route
// handler (`<c>.handler`); `section` counts its flagged layout
// (`section.layout`) and `slot` its slot handler (`slot.side`). `slot-b` is a
// second route beside the same slot: between the two the client holds the
// slot.
//
// Three more routes sit inside the `section` layout, to tell a layout that
// is new to the client from one it holds: `section-plain` (no loading() of
// its own), `section-own` (its own flagged loading()) and `section-cached`
// (a cache() route). Each counts its handler and its loader.
//
// `item/:id` is one route with a flagged loader, linked as `item/a` and
// `item/b`: moving between them is a same-route navigation, whose segments
// the client holds. `item-twin/:id` is the same route without the flag. Both
// print their param as pf-<c>-id. `vt` is a flagged loader on a route with
// transition().
//
// `vt-unit` is a unit on a route with transition(). `vt-unit-off` is the same
// with transition({ viewTransition: false }): React holds the commit and the
// router places no <ViewTransition>. `vt-unit-own` adds the app's own boundary
// around the page, and `unit-own` has that boundary and no transition().
//
// `inner` and `vt-inner` are a unit whose content has a boundary of its own
// around a slower read: pf-<c>-early (counter `<c>.early`) is what the unit's
// fallback waits for, pf-<c>-late-fallback covers pf-<c>-value, 150 ms behind.
// `nested` is the same page with no unit: two flagged loaders, each read
// behind a <Suspense> of its own (pf-nested-outer-fallback around both).
//
// `above` is a unit whose loader the layout above it reads too
// (pf-above-read, in pf-above-layout): a reader above the unit's fallback,
// with no boundary of its own. `bare-inner` is `bare` with a second flagged
// loader, 600 ms slower, behind a <Suspense> (pf-bare-inner-early is the read
// with no boundary): the fill's response stays open after the value the page
// waits for. `vt-below` is a flagged loading() on a layout
// (pf-vt-below-layout, counter `vt-below.layout`) whose route has
// transition(): the prefetch skips the route, transition() included.
//
// pf-nav mirrors useNavigation() as data-state / data-streaming / data-path
// (its location's pathname), and pf-outlet is the box the page renders in.
//
// Four cases have no value to show: their deferred work ends another way.
// `throws` and `missing` render pf-<c>-error / pf-<c>-not-found, `redirects`
// lands on the `control` page, and `handle` pushes a note the hub layout
// lists as pf-note-handle.
//
// By hand: /prefetch-false?run=<anything>&manual=1 adds a live panel of the
// server's run counts and a scrollY badge; &tall=1 makes the page scrollable.
// &slow=1 makes every `<c>.data` loader take 600 ms longer, past the 300 ms
// React keeps a fallback up before it reveals what replaces it: the deferred
// work is then the last thing a plain navigation waits for, too.
// &delay=<ms> adds that much to the same loaders: where a loader lands
// between the click and the end of a view transition decides what a reveal
// has to wait for.
// &hslow=1 makes the section layout's handler take 600 ms: work a click must
// not repeat for a layout the page already shows.
// &boundary=1 puts the heading in a <ViewTransition> of the app's own. It is
// on screen before, during and after every click, and React starts a view
// transition for any commit made in a transition while one is mounted.
// &vtms=<ms> makes every view transition take that long (the default is
// about 250 ms): what a commit that waits for one waits for.
// The flags ride on every link. Without them the page is quiet for a suite.

const runOf = (ctx: any): string => ctx.searchParams.get("run") ?? "";

const delayOf = (ctx: any): number =>
  Number(ctx.searchParams.get("delay") ?? 0) || 0;

async function work(ctx: any, name: string, delayMs: number = 0) {
  const n = countRun(runOf(ctx), name);
  const timed = name.endsWith(".data") || name.endsWith(".early");
  const slow = timed && ctx.searchParams.get("slow") === "1";
  const wait = delayMs + (slow ? 600 : 0) + (timed ? delayOf(ctx) : 0);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return { name, n };
}

// `export const` so the expose-internal-ids transform gives each a stable $$id.
export const PfPriceLoader = createLoader((ctx) => work(ctx, "loader.price"));
export const PfReviewsLoader = createLoader((ctx) =>
  work(ctx, "loader.data", 100),
);
export const PfUnitLoader = createLoader((ctx) => work(ctx, "unit.data", 100));
export const PfCachedLoader = createLoader((ctx) =>
  work(ctx, "cached.data", 100),
);
export const PfPrerenderedLoader = createLoader((ctx) =>
  work(ctx, "prerendered.data", 100),
);
export const PfPprLoader = createLoader((ctx) => work(ctx, "ppr.data", 100));
export const PfSsrFalseLoader = createLoader((ctx) =>
  work(ctx, "ssr-false.data", 100),
);
export const PfControlLoader = createLoader((ctx) =>
  work(ctx, "control.data", 100),
);
export const PfSectionLoader = createLoader((ctx) =>
  work(ctx, "section.data", 100),
);
export const PfSlotLoader = createLoader((ctx) => work(ctx, "slot.data", 100));
export const PfBareLoader = createLoader((ctx) => work(ctx, "bare.data", 100));
export const PfThrowsLoader = createLoader(async (ctx) => {
  await work(ctx, "throws.data", 100);
  throw new Error("pf-throws");
});
export const PfMissingLoader = createLoader(async (ctx) => {
  await work(ctx, "missing.data", 100);
  return notFound("pf-missing");
});
export const PfRedirectsLoader = createLoader(async (ctx) => {
  await work(ctx, "redirects.data", 100);
  throw redirect(`/prefetch-false/control?run=${runOf(ctx)}`);
});
export const PfHandleLoader = createLoader((ctx) =>
  work(ctx, "handle.data", 100),
);
export const PfSectionPlainLoader = createLoader((ctx) =>
  work(ctx, "section-plain.data", 100),
);
export const PfSectionOwnLoader = createLoader((ctx) =>
  work(ctx, "section-own.data", 100),
);
export const PfSectionCachedLoader = createLoader((ctx) =>
  work(ctx, "section-cached.data", 100),
);
export const PfItemLoader = createLoader((ctx) => work(ctx, "item.data", 100));
export const PfItemTwinLoader = createLoader((ctx) =>
  work(ctx, "item-twin.data", 100),
);
export const PfVtLoader = createLoader((ctx) => work(ctx, "vt.data", 100));
export const PfVtUnitLoader = createLoader((ctx) =>
  work(ctx, "vt-unit.data", 100),
);
export const PfVtUnitOffLoader = createLoader((ctx) =>
  work(ctx, "vt-unit-off.data", 100),
);
export const PfVtUnitOwnLoader = createLoader((ctx) =>
  work(ctx, "vt-unit-own.data", 100),
);
export const PfUnitOwnLoader = createLoader((ctx) =>
  work(ctx, "unit-own.data", 100),
);
export const PfInnerEarlyLoader = createLoader((ctx) =>
  work(ctx, "inner.early", 100),
);
export const PfInnerLoader = createLoader((ctx) =>
  work(ctx, "inner.data", 250),
);
export const PfVtInnerEarlyLoader = createLoader((ctx) =>
  work(ctx, "vt-inner.early", 100),
);
export const PfVtInnerLoader = createLoader((ctx) =>
  work(ctx, "vt-inner.data", 250),
);
export const PfNestedEarlyLoader = createLoader((ctx) =>
  work(ctx, "nested.early", 100),
);
export const PfNestedLoader = createLoader((ctx) =>
  work(ctx, "nested.data", 250),
);
export const PfAboveLoader = createLoader((ctx) =>
  work(ctx, "above.data", 100),
);
export const PfBareInnerEarlyLoader = createLoader((ctx) =>
  work(ctx, "bare-inner.early", 100),
);
export const PfBareInnerLoader = createLoader((ctx) =>
  work(ctx, "bare-inner.data", 700),
);
export const PfVtBelowLoader = createLoader((ctx) =>
  work(ctx, "vt-below.data", 100),
);

const CASES = [
  ["loader", "one flagged loader beside an unflagged one, own Suspense"],
  ["unit", "flagged loading() on a route: handler and loader wait"],
  ["section", "flagged loading() on a layout: layout and route wait"],
  ["section-plain", "inside that layout, no loading(): waits only with it"],
  ["section-own", "inside that layout, its own flagged loading()"],
  ["section-cached", "inside that layout, a cache() route: record is used"],
  ["slot", "flagged loading() on a parallel slot: only the slot waits"],
  ["slot-b", "a second route beside that slot: from slot, the slot is held"],
  ["bare", "flagged loader, no boundary: the click waits for the fill"],
  ["throws", "the deferred loader throws: error boundary after the click"],
  ["missing", "the deferred loader calls notFound()"],
  ["redirects", "the deferred loader redirects to control"],
  ["handle", "the deferred handler pushes a handle (listed below)"],
  ["cached", "cache() route: handler is stored, only the loader waits"],
  ["prerendered", "Prerender route: only the loader waits"],
  ["ppr", "ppr route: shell replays, the live loader waits"],
  ["ssr-false", "ssr: false with prefetch: false"],
  ["control", "no flag: the prefetch runs everything"],
  ["item/a", "same route, flagged loader: held segments are never deferred"],
  ["item/b", "from item/a the prefetch runs the loader, no fill"],
  ["item-twin/a", "the same route without the flag"],
  ["item-twin/b", "must behave exactly like item/a to item/b"],
  ["vt", "flagged loader on a route with transition()"],
  ["vt-unit", "flagged loading() on a route with transition()"],
  ["vt-unit-off", "the same with transition({ viewTransition: false })"],
  ["vt-unit-own", "and the app's own <ViewTransition> around the page"],
  ["unit-own", "that boundary on a unit with no transition()"],
  ["inner", "flagged loading(), a slower read behind its own Suspense"],
  ["vt-inner", "the same on a route with transition()"],
  ["nested", "two flagged loaders, the second read in a nested Suspense"],
  ["above", "flagged loading(), its loader also read by the layout above"],
  ["bare-inner", "bare, and a slower flagged loader behind a Suspense"],
  ["vt-below", "flagged loading() on a layout, transition() on its route"],
] as const;

const box = {
  padding: 12,
  border: "1px solid rgba(128,128,128,0.5)",
  borderRadius: 6,
} as const;

function PrefetchFalseLayout(ctx: any) {
  const run = runOf(ctx);
  const tall = ctx.searchParams.get("tall") === "1";
  const manual = ctx.searchParams.get("manual") === "1";
  const slow = ctx.searchParams.get("slow") === "1";
  const hslow = ctx.searchParams.get("hslow") === "1";
  const delay = delayOf(ctx);
  const boundary = ctx.searchParams.get("boundary") === "1";
  const vtms = Number(ctx.searchParams.get("vtms") ?? 0) || 0;
  const query = `run=${run}${manual ? "&manual=1" : ""}${tall ? "&tall=1" : ""}${slow ? "&slow=1" : ""}${delay ? `&delay=${delay}` : ""}${hslow ? "&hslow=1" : ""}${boundary ? "&boundary=1" : ""}${vtms ? `&vtms=${vtms}` : ""}`;
  const heading = <h2 style={{ margin: "16px 0 4px" }}>prefetch: false</h2>;
  return (
    <div
      data-testid="pf-layout"
      style={{ fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}
    >
      {vtms > 0 && (
        <style>{`::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation-duration:${vtms}ms}`}</style>
      )}
      {boundary ? <ViewTransition>{heading}</ViewTransition> : heading}
      <p style={{ margin: "0 0 12px", opacity: 0.75 }}>
        Hover a link to prefetch it, then click it. The panel on the right shows
        what the server ran.
      </p>
      {tall && (
        <div style={{ ...box, height: 700, opacity: 0.6 }}>
          Scroll test: this block makes the page tall. Scroll down to the links,
          then hover and click one. A navigation should end at the top of the
          page.
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 280px",
          gap: 24,
          alignItems: "start",
        }}
      >
        <nav>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: 4,
            }}
          >
            <li style={{ display: "grid", gridTemplateColumns: "110px 1fr" }}>
              <Link
                to={`/prefetch-false?${query}`}
                data-testid="pf-link-hub"
                prefetch="none"
              >
                hub
              </Link>
              <span style={{ opacity: 0.75 }}>
                an empty page, never prefetched
              </span>
            </li>
            {CASES.map(([name, note]) => (
              <li
                key={name}
                style={{ display: "grid", gridTemplateColumns: "110px 1fr" }}
              >
                <Link
                  to={`/prefetch-false/${name}?${query}`}
                  data-testid={`pf-link-${name}`}
                  prefetch="hover"
                >
                  {name}
                </Link>
                <span style={{ opacity: 0.75 }}>{note}</span>
              </li>
            ))}
          </ul>
        </nav>
        {manual && <PrefetchFalseCounts run={run} tall={tall} />}
      </div>
      <div style={{ margin: "16px 0 4px", fontSize: 12, opacity: 0.6 }}>
        HANDLE PUSHES
      </div>
      <PrefetchFalseNotes />
      <PrefetchFalseNav />
      <div style={{ margin: "16px 0 4px", fontSize: 12, opacity: 0.6 }}>
        PAGE
      </div>
      <div style={box} data-testid="pf-outlet">
        <Outlet />
      </div>
      {tall && <div style={{ height: 1600 }} />}
      {manual && <PrefetchFalseScroll />}
    </div>
  );
}

const fallback = (name: string) => (
  <div
    data-testid={`pf-${name}-fallback`}
    style={{
      display: "inline-block",
      padding: "4px 10px",
      border: "1px dashed #d9a400",
      borderRadius: 4,
      background: "rgba(217,164,0,0.15)",
    }}
  >
    {name} loading
  </div>
);

// One flagged loader beside an unflagged one. The flagged read has its own
// boundary, so the page and the unflagged value show while it is missing.
function LoaderPage(ctx: any) {
  countRun(runOf(ctx), "loader.handler");
  // A push from a handler no prefetch defers: it arrives with the prefetch.
  ctx.use(PfNotes)("loader");
  return (
    <div data-testid="pf-loader-page">
      <PrefetchFalseValue loader={PfPriceLoader} testId="pf-loader-price" />
      <Suspense fallback={fallback("loader")}>
        <PrefetchFalseValue loader={PfReviewsLoader} testId="pf-loader-value" />
      </Suspense>
    </div>
  );
}

function UnitPage(ctx: any) {
  countRun(runOf(ctx), "unit.handler");
  return (
    <div data-testid="pf-unit-page">
      <PrefetchFalseValue loader={PfUnitLoader} testId="pf-unit-value" />
    </div>
  );
}

// A flagged loading() on a layout covers its outlet: the route below.
async function SectionLayout(ctx: any) {
  countRun(runOf(ctx), "section.layout");
  if (ctx.searchParams.get("hslow") === "1") {
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return (
    <section data-testid="pf-section-layout">
      <Outlet />
    </section>
  );
}

function SectionPage(ctx: any) {
  countRun(runOf(ctx), "section.handler");
  return (
    <div data-testid="pf-section-page">
      <PrefetchFalseValue loader={PfSectionLoader} testId="pf-section-value" />
    </div>
  );
}

// A page that counts its handler and reads one loader.
const countedPage = (name: string, loader: any) => (ctx: any) => {
  countRun(runOf(ctx), `${name}.handler`);
  return (
    <div data-testid={`pf-${name}-page`}>
      <PrefetchFalseValue loader={loader} testId={`pf-${name}-value`} />
    </div>
  );
};

// The same page inside a <ViewTransition> the app places: what
// transition({ viewTransition: false }) is for.
const ownBoundaryPage = (name: string, loader: any) => (ctx: any) => {
  countRun(runOf(ctx), `${name}.handler`);
  return (
    <ViewTransition>
      <div data-testid={`pf-${name}-page`}>
        <PrefetchFalseValue loader={loader} testId={`pf-${name}-value`} />
      </div>
    </ViewTransition>
  );
};

// One route, two params: the client holds its segments between them.
const itemPage = (name: string, loader: any) => (ctx: any) => {
  countRun(runOf(ctx), `${name}.handler`);
  return (
    <div data-testid={`pf-${name}-page`}>
      <span data-testid={`pf-${name}-id`}>{ctx.params.id}</span>
      <PrefetchFalseValue loader={loader} testId={`pf-${name}-value`} />
    </div>
  );
};

function VtPage() {
  return (
    <div data-testid="pf-vt-page">
      <PrefetchFalseValue loader={PfVtLoader} testId="pf-vt-value" />
    </div>
  );
}

function VtUnitPage(ctx: any) {
  countRun(runOf(ctx), "vt-unit.handler");
  return (
    <div data-testid="pf-vt-unit-page">
      <PrefetchFalseValue loader={PfVtUnitLoader} testId="pf-vt-unit-value" />
    </div>
  );
}

// A unit whose content shows before its slowest read: that read has a
// boundary of its own.
const innerPage = (name: string, early: any, late: any) => (ctx: any) => {
  countRun(runOf(ctx), `${name}.handler`);
  return (
    <div data-testid={`pf-${name}-page`}>
      <PrefetchFalseValue loader={early} testId={`pf-${name}-early`} />
      <Suspense fallback={fallback(`${name}-late`)}>
        <PrefetchFalseValue loader={late} testId={`pf-${name}-value`} />
      </Suspense>
    </div>
  );
};

// Two deferred reads, one boundary inside the other.
function NestedPage() {
  return (
    <div data-testid="pf-nested-page">
      <Suspense fallback={fallback("nested-outer")}>
        <PrefetchFalseValue
          loader={PfNestedEarlyLoader}
          testId="pf-nested-early"
        />
        <Suspense fallback={fallback("nested-late")}>
          <PrefetchFalseValue
            loader={PfNestedLoader}
            testId="pf-nested-value"
          />
        </Suspense>
      </Suspense>
    </div>
  );
}

// Reads its route's loader, with no boundary: above the route's fallback.
function AboveLayout() {
  return (
    <div data-testid="pf-above-layout">
      <PrefetchFalseValue loader={PfAboveLoader} testId="pf-above-read" />
      <Outlet />
    </div>
  );
}

// A flagged loading() on a layout whose route has transition().
function VtBelowLayout(ctx: any) {
  countRun(runOf(ctx), "vt-below.layout");
  return (
    <section data-testid="pf-vt-below-layout">
      <Outlet />
    </section>
  );
}

// A slot with its own flagged loading() is its own unit: the route renders.
function SlotLayout() {
  return (
    <div data-testid="pf-slot-layout">
      <Outlet />
      <ParallelOutlet name="@side" />
    </div>
  );
}

function SlotPage(ctx: any) {
  countRun(runOf(ctx), "slot.handler");
  return <div data-testid="pf-slot-page">slot page</div>;
}

function SlotPageB(ctx: any) {
  countRun(runOf(ctx), "slot-b.handler");
  return (
    <div data-testid="pf-slot-b-page">
      <span data-testid="pf-slot-b-value">slot-b page</span>
    </div>
  );
}

function SlotSide(ctx: any) {
  countRun(runOf(ctx), "slot.side");
  return (
    <aside data-testid="pf-slot-side">
      <PrefetchFalseValue loader={PfSlotLoader} testId="pf-slot-value" />
    </aside>
  );
}

// No loading() and no Suspense around the read: nothing can show a fallback.
function BarePage() {
  return (
    <div data-testid="pf-bare-page">
      <PrefetchFalseValue loader={PfBareLoader} testId="pf-bare-value" />
    </div>
  );
}

// Deferred work that does not end in a value: the read is all there is.
const signalPage = (name: string, loader: any) => () => (
  <div data-testid={`pf-${name}-page`}>
    <PrefetchFalseValue loader={loader} testId={`pf-${name}-value`} />
  </div>
);

// A deferred handler that pushes a handle: the push arrives with the fill.
function HandlePage(ctx: any) {
  ctx.use(PfNotes)("handle");
  return (
    <div data-testid="pf-handle-page">
      <PrefetchFalseValue loader={PfHandleLoader} testId="pf-handle-value" />
    </div>
  );
}

function CachedPage(ctx: any) {
  countRun(runOf(ctx), "cached.handler");
  return (
    <div data-testid="pf-cached-page">
      <PrefetchFalseValue loader={PfCachedLoader} testId="pf-cached-value" />
    </div>
  );
}

// Built once: no request to count a run under. `export const`: the build
// extracts a Prerender handler by its export name.
export const PfPrerenderedPage = Prerender(async () => (
  <div data-testid="pf-prerendered-page">
    <PrefetchFalseValue
      loader={PfPrerenderedLoader}
      testId="pf-prerendered-value"
    />
  </div>
));

function PprPage() {
  return (
    <div data-testid="pf-ppr-page">
      <PrefetchFalseValue loader={PfPprLoader} testId="pf-ppr-value" />
    </div>
  );
}

function SsrFalsePage() {
  return (
    <div data-testid="pf-ssr-false-page">
      <PrefetchFalseValue
        loader={PfSsrFalseLoader}
        testId="pf-ssr-false-value"
      />
    </div>
  );
}

function ControlPage() {
  return (
    <div data-testid="pf-control-page">
      <PrefetchFalseValue loader={PfControlLoader} testId="pf-control-value" />
    </div>
  );
}

export const prefetchFalsePatterns = urls(
  ({
    path,
    layout,
    loader,
    loading,
    cache,
    parallel,
    transition,
    errorBoundary,
    notFoundBoundary,
  }) => [
    path.json(
      "/__counts",
      (ctx): Record<string, number> => readRunCounts(runOf(ctx)),
      { name: "counts" },
    ),
    layout(PrefetchFalseLayout, () => [
      path("/", () => <div data-testid="pf-hub">hub</div>, { name: "index" }),

      // A flagged loader: skipped in a prefetch, fetched by the click.
      path("/loader", LoaderPage, { name: "loader" }, () => [
        loader(PfPriceLoader),
        loader(PfReviewsLoader, { prefetch: false }),
        loading(<div data-testid="pf-loader-loading">loader loading</div>),
      ]),

      // A flagged loading() on a plain route: the handler and its loader are
      // skipped together, the fallback is sent.
      path("/unit", UnitPage, { name: "unit" }, () => [
        loader(PfUnitLoader),
        loading(fallback("unit"), { prefetch: false }),
      ]),

      // A flagged loading() on a layout: the layout, the route below it and
      // the route's loader are skipped together.
      layout(SectionLayout, () => [
        loading(fallback("section"), { prefetch: false }),
        path("/section", SectionPage, { name: "section" }, () => [
          loader(PfSectionLoader),
        ]),
        // From outside the section these wait with the layout. From inside
        // it the client holds the layout, so its flag has no say: a route
        // with no flag of its own is prefetched whole, a route with its own
        // flagged loading() is its own unit, and a cache() route uses its
        // record.
        path(
          "/section-plain",
          countedPage("section-plain", PfSectionPlainLoader),
          { name: "sectionPlain" },
          () => [loader(PfSectionPlainLoader)],
        ),
        path(
          "/section-own",
          countedPage("section-own", PfSectionOwnLoader),
          { name: "sectionOwn" },
          () => [
            loader(PfSectionOwnLoader),
            loading(fallback("section-own"), { prefetch: false }),
          ],
        ),
        cache({ ttl: 600 }, () => [
          path(
            "/section-cached",
            countedPage("section-cached", PfSectionCachedLoader),
            { name: "sectionCached" },
            () => [loader(PfSectionCachedLoader)],
          ),
        ]),
      ]),

      // A slot with its own flagged loading(): the slot and its loader are
      // skipped, the route beside it renders in the prefetch.
      layout(SlotLayout, () => [
        parallel({ "@side": SlotSide }, () => [
          loader(PfSlotLoader),
          loading(fallback("slot"), { prefetch: false }),
        ]),
        path("/slot", SlotPage, { name: "slot" }),
        path("/slot-b", SlotPageB, { name: "slotB" }),
      ]),

      // A flagged loader nothing can show a fallback for: the page left stays
      // on screen until the fill returns.
      path("/bare", BarePage, { name: "bare" }, () => [
        loader(PfBareLoader, { prefetch: false }),
      ]),

      // What deferred work can end in besides a value. Each lands where it
      // would for work that streams behind loading(), once the fill returns.
      path(
        "/throws",
        signalPage("throws", PfThrowsLoader),
        { name: "throws" },
        () => [
          loader(PfThrowsLoader, { prefetch: false }),
          loading(fallback("throws")),
          errorBoundary((props) => (
            <div data-testid="pf-throws-error">{props.error.message}</div>
          )),
        ],
      ),
      path(
        "/missing",
        signalPage("missing", PfMissingLoader),
        { name: "missing" },
        () => [
          loader(PfMissingLoader, { prefetch: false }),
          loading(fallback("missing")),
          notFoundBoundary(({ notFound: info }) => (
            <div data-testid="pf-missing-not-found">{info.message}</div>
          )),
        ],
      ),
      path(
        "/redirects",
        signalPage("redirects", PfRedirectsLoader),
        { name: "redirects" },
        () => [
          loader(PfRedirectsLoader, { prefetch: false }),
          loading(fallback("redirects")),
        ],
      ),
      path("/handle", HandlePage, { name: "handle" }, () => [
        loader(PfHandleLoader),
        loading(fallback("handle"), { prefetch: false }),
      ]),

      // Stored handler output: cache() serves the handler as usual, only the
      // loader behind the fallback is skipped.
      cache({ ttl: 600 }, () => [
        path("/cached", CachedPage, { name: "cached" }, () => [
          loader(PfCachedLoader),
          loading(fallback("cached"), { prefetch: false }),
        ]),
      ]),

      path("/prerendered", PfPrerenderedPage, { name: "prerendered" }, () => [
        loader(PfPrerenderedLoader),
        loading(fallback("prerendered"), { prefetch: false }),
      ]),

      // ppr: the live loader is skipped, the shell replays as usual.
      path("/ppr", PprPage, { name: "ppr", ppr: true }, () => [
        loader(PfPprLoader, { prefetch: false }),
        loading(fallback("ppr")),
      ]),

      // Both options: the document awaits the loader, a prefetch skips it.
      path("/ssr-false", SsrFalsePage, { name: "ssrFalse" }, () => [
        loader(PfSsrFalseLoader, { ssr: false, prefetch: false }),
        loading(fallback("ssr-false")),
      ]),

      // A same-route navigation: the client holds the route and the loader
      // segment, so a prefetch runs the flagged loader like its twin's.
      path(
        "/item/:id",
        itemPage("item", PfItemLoader),
        { name: "item" },
        () => [
          loader(PfItemLoader, { prefetch: false }),
          loading(fallback("item")),
        ],
      ),
      path(
        "/item-twin/:id",
        itemPage("item-twin", PfItemTwinLoader),
        { name: "itemTwin" },
        () => [loader(PfItemTwinLoader), loading(fallback("item-twin"))],
      ),

      // A flagged loader on a route with a view transition.
      path("/vt", VtPage, { name: "vt" }, () => [
        loader(PfVtLoader, { prefetch: false }),
        loading(fallback("vt")),
        transition(),
      ]),

      // A deferred unit on a route with a view transition.
      path("/vt-unit", VtUnitPage, { name: "vtUnit" }, () => [
        loader(PfVtUnitLoader),
        loading(fallback("vt-unit"), { prefetch: false }),
        transition(),
      ]),

      // The same unit with no router boundary, with the app's own boundary
      // in its place, and with that boundary and no transition() at all.
      path(
        "/vt-unit-off",
        countedPage("vt-unit-off", PfVtUnitOffLoader),
        { name: "vtUnitOff" },
        () => [
          loader(PfVtUnitOffLoader),
          loading(fallback("vt-unit-off"), { prefetch: false }),
          transition({ viewTransition: false }),
        ],
      ),
      path(
        "/vt-unit-own",
        ownBoundaryPage("vt-unit-own", PfVtUnitOwnLoader),
        { name: "vtUnitOwn" },
        () => [
          loader(PfVtUnitOwnLoader),
          loading(fallback("vt-unit-own"), { prefetch: false }),
          transition({ viewTransition: false }),
        ],
      ),
      path(
        "/unit-own",
        ownBoundaryPage("unit-own", PfUnitOwnLoader),
        { name: "unitOwn" },
        () => [
          loader(PfUnitOwnLoader),
          loading(fallback("unit-own"), { prefetch: false }),
        ],
      ),

      // A deferred unit with a boundary inside it, without and with a view
      // transition.
      path(
        "/inner",
        innerPage("inner", PfInnerEarlyLoader, PfInnerLoader),
        { name: "inner" },
        () => [
          loader(PfInnerEarlyLoader),
          loader(PfInnerLoader),
          loading(fallback("inner"), { prefetch: false }),
        ],
      ),
      path(
        "/vt-inner",
        innerPage("vt-inner", PfVtInnerEarlyLoader, PfVtInnerLoader),
        { name: "vtInner" },
        () => [
          loader(PfVtInnerEarlyLoader),
          loader(PfVtInnerLoader),
          loading(fallback("vt-inner"), { prefetch: false }),
          transition(),
        ],
      ),

      // Two flagged loaders read in nested boundaries.
      path("/nested", NestedPage, { name: "nested" }, () => [
        loader(PfNestedEarlyLoader, { prefetch: false }),
        loader(PfNestedLoader, { prefetch: false }),
        loading(fallback("nested")),
      ]),

      // A unit whose loader the layout above it reads as well.
      layout(AboveLayout, () => [
        path(
          "/above",
          countedPage("above", PfAboveLoader),
          { name: "above" },
          () => [
            loader(PfAboveLoader),
            loading(fallback("above"), { prefetch: false }),
          ],
        ),
      ]),

      // A flagged loader nothing can show a fallback for, and a slower one
      // behind a boundary: the response outlives the value the page waits for.
      path(
        "/bare-inner",
        innerPage("bare-inner", PfBareInnerEarlyLoader, PfBareInnerLoader),
        { name: "bareInner" },
        () => [
          loader(PfBareInnerEarlyLoader, { prefetch: false }),
          loader(PfBareInnerLoader, { prefetch: false }),
        ],
      ),

      // A flagged loading() on a layout: the prefetch skips the route below
      // it, and with it the route's transition().
      layout(VtBelowLayout, () => [
        loading(fallback("vt-below"), { prefetch: false }),
        path(
          "/vt-below",
          countedPage("vt-below", PfVtBelowLoader),
          { name: "vtBelow" },
          () => [loader(PfVtBelowLoader), transition()],
        ),
      ]),

      // No flag: a prefetch runs everything and the click sends nothing.
      path("/control", ControlPage, { name: "control" }, () => [
        loader(PfControlLoader),
        loading(fallback("control")),
      ]),
    ]),
  ],
);
