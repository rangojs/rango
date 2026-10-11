"use client";

import { Suspense } from "react";
import {
  clientUrls,
  useOutlet,
  useParams,
  useSearchParams,
} from "@rangojs/router/client";
import { PrefetchFalseValue } from "../components/PrefetchFalseValue.js";
import {
  PfCuBareLoader,
  PfCuItemLoader,
  PfCuPriceLoader,
  PfCuReviewsLoader,
  PfCuVtLoader,
} from "./prefetch-false-client-urls.loader.js";
import { pfCuAction } from "./prefetch-false.actions.js";

// `prefetch: false` on clientUrls() routes (docs/design/prefetch-false.md,
// "`clientUrls()` routes"), mounted at /prefetch-false/cu by
// urls/prefetch-false.tsx, under a server layout with a flagged loader
// (pf-cu-above-layout). Every route sits in one group layout
// (pf-cu-layout), whose data-pending is useOutlet().pending.
//
//   cu          the in-group origin: no loaders (pf-cu-value is static)
//   cu/loader   an unflagged loader (pf-cu/loader-price) beside a flagged
//               one read in its own Suspense (pf-cu/loader-fallback), and
//               a button that sends a server action (pf-cu-action)
//   cu/bare     a flagged loader read with no boundary
//   cu/item/:id one route, two params: a same-route navigation
//   cu/vt       a flagged loader on a route with transition()
//
// Counters as in the rest of the fixture: `<case>.data` for the flagged
// loader, `cu/loader.price`, `cu/action`.

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

function CuLayout() {
  const { content, pending } = useOutlet();
  return (
    <section data-testid="pf-cu-layout" data-pending={String(pending)}>
      {content}
    </section>
  );
}

function CuIndex() {
  return (
    <div data-testid="pf-cu-page">
      <span data-testid="pf-cu-value">cu</span>
    </div>
  );
}

function CuAction() {
  const [searchParams] = useSearchParams();
  const run = searchParams.get("run") ?? "";
  return (
    <button
      type="button"
      data-testid="pf-cu-action"
      onClick={() => void pfCuAction(run)}
    >
      send an action
    </button>
  );
}

function CuLoaderPage() {
  return (
    <div data-testid="pf-cu/loader-page">
      <PrefetchFalseValue
        loader={PfCuPriceLoader}
        testId="pf-cu/loader-price"
      />
      <Suspense fallback={fallback("cu/loader")}>
        <PrefetchFalseValue
          loader={PfCuReviewsLoader}
          testId="pf-cu/loader-value"
        />
      </Suspense>
      <CuAction />
    </div>
  );
}

function CuBarePage() {
  return (
    <div data-testid="pf-cu/bare-page">
      <PrefetchFalseValue loader={PfCuBareLoader} testId="pf-cu/bare-value" />
    </div>
  );
}

function CuItemPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div data-testid="pf-cu/item-page">
      <span data-testid="pf-cu/item-id">{id}</span>
      <Suspense fallback={fallback("cu/item")}>
        <PrefetchFalseValue loader={PfCuItemLoader} testId="pf-cu/item-value" />
      </Suspense>
    </div>
  );
}

function CuVtPage() {
  return (
    <div data-testid="pf-cu/vt-page">
      <Suspense fallback={fallback("cu/vt")}>
        <PrefetchFalseValue loader={PfCuVtLoader} testId="pf-cu/vt-value" />
      </Suspense>
    </div>
  );
}

export default clientUrls(({ path, layout, loader, loading, transition }) => [
  layout(CuLayout, () => [
    path("/", CuIndex, { name: "index" }),
    path("/loader", CuLoaderPage, { name: "loader" }, () => [
      loader(PfCuPriceLoader),
      loader(PfCuReviewsLoader, { prefetch: false }),
      loading(<div data-testid="pf-cu/loader-loading">cu/loader loading</div>),
    ]),
    path("/bare", CuBarePage, { name: "bare" }, () => [
      loader(PfCuBareLoader, { prefetch: false }),
    ]),
    path("/item/:id", CuItemPage, { name: "item" }, () => [
      loader(PfCuItemLoader, { prefetch: false }),
    ]),
    path("/vt", CuVtPage, { name: "vt" }, () => [
      loader(PfCuVtLoader, { prefetch: false }),
      transition({}),
    ]),
  ]),
]);
