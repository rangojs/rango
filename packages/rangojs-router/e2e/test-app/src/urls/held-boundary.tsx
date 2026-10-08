import { urls, loader, loading, type Handler } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import {
  UlrLoader,
  ZlbLayoutLoader,
  ZlbRouteLoader,
  ZlbSlotLoader,
} from "./held-boundary.loaders.js";
import {
  UlrValue,
  ZlbLayoutValue,
  ZlbRouteValue,
  ZlbSlotValue,
} from "./held-boundary.client.js";

/**
 * Held-boundary fixtures. The hub (/zlb) sits outside every layout, so
 * entering /<s>/a mounts the layout fresh; per scenario s the hub has a
 * hover-prefetched and a plain link to /<s>/a, and /<s>/a links to /<s>/b
 * with prefetch off.
 *
 *  - zlb : layout with loading() and no loaders
 *  - zlbl: layout with loading() and one loader read by useLoader
 *  - zlbs: parallel slot with its own loader and loading()
 *  - zlbr: layout without loading(); each child route has its own loader and
 *          loading() (the new route's fallback may show, the layout is held)
 */

function HubLinks({ s }: { s: string }) {
  return (
    <div>
      <Link
        to={`/${s}/a` as string}
        data-testid={`${s}-hub-prefetched`}
        prefetch="hover"
      >
        {s} a (hover prefetch)
      </Link>
      <Link
        to={`/${s}/a` as string}
        data-testid={`${s}-hub-plain`}
        prefetch="none"
      >
        {s} a (no prefetch)
      </Link>
    </div>
  );
}

const ZlbHub: Handler = () => (
  <div data-testid="zlb-hub">
    {["zlb", "zlbl", "zlbs", "zlbr"].map((s) => (
      <HubLinks key={s} s={s} />
    ))}
  </div>
);

function toB(s: string) {
  return (
    <Link to={`/${s}/b` as string} data-testid={`${s}-to-b`} prefetch="none">
      b
    </Link>
  );
}

const page =
  (s: string, which: "a" | "b"): Handler =>
  () => (
    <div data-testid={`${s}-${which}`}>
      {which}
      {which === "a" ? toB(s) : null}
    </div>
  );

const ZlbLayout: Handler = () => (
  <div data-testid="zlb-layout">
    <Outlet />
  </div>
);

const ZlbLLayout: Handler = () => (
  <div data-testid="zlbl-layout">
    <ZlbLayoutValue />
    <Outlet />
  </div>
);

const ZlbSLayout: Handler = () => (
  <div data-testid="zlbs-layout">
    <Outlet />
    <ParallelOutlet name="@zlbsSlot" />
  </div>
);

const ZlbSSlot: Handler = () => (
  <div data-testid="zlbs-slot">
    <ZlbSlotValue />
  </div>
);

const ZlbRLayout: Handler = () => (
  <div data-testid="zlbr-layout">
    <Outlet />
  </div>
);

const routePage =
  (which: "a" | "b"): Handler =>
  () => (
    <div data-testid={`zlbr-${which}`}>
      {which}
      <ZlbRouteValue />
      {which === "a" ? toB("zlbr") : null}
    </div>
  );

/**
 * ulr: a route whose useLoader reader mounts while its loader streams (reached
 * from the /ulr hub), then renders again with the value settled after a click
 * to the page already shown, or back in the history.
 * React logs a conditional use() in dev when the read skips use() on the
 * settled render (use-loader.tsx).
 */
const UlrHub: Handler = () => (
  <div data-testid="ulr-hub">
    <Link to="/ulr/a" data-testid="ulr-hub-plain" prefetch="none">
      ulr a
    </Link>{" "}
  </div>
);

const UlrPage: Handler = () => (
  <div data-testid="ulr-a">
    <UlrValue />
    <Link to="/ulr/a" data-testid="ulr-self-plain" prefetch="none">
      self
    </Link>
    <Link to="/ulr" data-testid="ulr-to-hub" prefetch="none">
      hub
    </Link>
  </div>
);

export const heldBoundaryPatterns = urls(
  ({ layout, path, loading, parallel }) => [
    path("/zlb", ZlbHub, { name: "zlbHub" }),

    path("/ulr", UlrHub, { name: "ulrHub" }),
    path("/ulr/a", UlrPage, { name: "ulrA" }, () => [
      loader(UlrLoader),
      loading(<div data-testid="ulr-fallback">ulr-loading</div>),
    ]),

    layout(ZlbLayout, () => [
      loading(<div data-testid="zlb-fallback">zlb-loading</div>),
      path("/zlb/a", page("zlb", "a"), { name: "zlbA" }),
      path("/zlb/b", page("zlb", "b"), { name: "zlbB" }),
    ]),

    layout(ZlbLLayout, () => [
      loader(ZlbLayoutLoader),
      loading(<div data-testid="zlbl-fallback">zlbl-loading</div>),
      path("/zlbl/a", page("zlbl", "a"), { name: "zlblA" }),
      path("/zlbl/b", page("zlbl", "b"), { name: "zlblB" }),
    ]),

    layout(ZlbSLayout, () => [
      parallel({ "@zlbsSlot": ZlbSSlot }, () => [
        loader(ZlbSlotLoader),
        loading(<div data-testid="zlbs-fallback">zlbs-loading</div>),
      ]),
      path("/zlbs/a", page("zlbs", "a"), { name: "zlbsA" }),
      path("/zlbs/b", page("zlbs", "b"), { name: "zlbsB" }),
    ]),

    layout(ZlbRLayout, () => [
      path("/zlbr/a", routePage("a"), { name: "zlbrA" }, () => [
        loader(ZlbRouteLoader),
        loading(<div data-testid="zlbr-fallback">zlbr-loading</div>),
      ]),
      path("/zlbr/b", routePage("b"), { name: "zlbrB" }, () => [
        loader(ZlbRouteLoader),
        loading(<div data-testid="zlbr-fallback">zlbr-loading</div>),
      ]),
    ]),
  ],
);
