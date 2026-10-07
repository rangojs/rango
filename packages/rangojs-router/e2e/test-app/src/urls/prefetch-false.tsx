import { Suspense } from "react";
import { urls, createLoader, Prerender } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { PrefetchFalseValue } from "../components/PrefetchFalseValue.js";
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
// (`section.layout`) and `slot` its slot handler (`slot.side`).

const runOf = (ctx: any): string => ctx.searchParams.get("run") ?? "";

async function work(ctx: any, name: string, delayMs: number = 0) {
  const n = countRun(runOf(ctx), name);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
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

const CASES = [
  "loader",
  "unit",
  "section",
  "slot",
  "bare",
  "cached",
  "prerendered",
  "ppr",
  "ssr-false",
  "control",
] as const;

function PrefetchFalseLayout(ctx: any) {
  const run = runOf(ctx);
  return (
    <div data-testid="pf-layout">
      <nav>
        <Link
          to={`/prefetch-false?run=${run}`}
          data-testid="pf-link-hub"
          prefetch="none"
        >
          hub
        </Link>
        {CASES.map((name) => (
          <Link
            key={name}
            to={`/prefetch-false/${name}?run=${run}`}
            data-testid={`pf-link-${name}`}
            prefetch="hover"
          >
            {name}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

const fallback = (name: string) => (
  <div data-testid={`pf-${name}-fallback`}>{name} loading</div>
);

// One flagged loader beside an unflagged one. The flagged read has its own
// boundary, so the page and the unflagged value show while it is missing.
function LoaderPage(ctx: any) {
  countRun(runOf(ctx), "loader.handler");
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
function SectionLayout(ctx: any) {
  countRun(runOf(ctx), "section.layout");
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
  ({ path, layout, loader, loading, cache, parallel }) => [
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
      ]),

      // A slot with its own flagged loading(): the slot and its loader are
      // skipped, the route beside it renders in the prefetch.
      layout(SlotLayout, () => [
        parallel({ "@side": SlotSide }, () => [
          loader(PfSlotLoader),
          loading(fallback("slot"), { prefetch: false }),
        ]),
        path("/slot", SlotPage, { name: "slot" }),
      ]),

      // A flagged loader nothing can show a fallback for: the page left stays
      // on screen until the fill returns.
      path("/bare", BarePage, { name: "bare" }, () => [
        loader(PfBareLoader, { prefetch: false }),
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

      // No flag: a prefetch runs everything and the click sends nothing.
      path("/control", ControlPage, { name: "control" }, () => [
        loader(PfControlLoader),
        loading(fallback("control")),
      ]),
    ]),
  ],
);
