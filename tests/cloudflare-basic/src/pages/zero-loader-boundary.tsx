import { urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

/**
 * A layout with loading() and no loaders over two plain children. The hub
 * sits outside the layout, so entering /zlb/a mounts the layout fresh; the
 * hub's two links enter it by a hover-prefetched click and by a plain click.
 * /zlb/a links to /zlb/b with prefetch off.
 */

const ZlbHub: Handler = () => (
  <div data-testid="zlb-hub">
    <Link to="/zlb/a" data-testid="zlb-hub-prefetched" prefetch="hover">
      a (hover prefetch)
    </Link>
    <Link to="/zlb/a" data-testid="zlb-hub-plain" prefetch="none">
      a (no prefetch)
    </Link>
  </div>
);

const ZlbLayout: Handler = () => (
  <div data-testid="zlb-layout">
    <Outlet />
  </div>
);

const ZlbA: Handler = () => (
  <div data-testid="zlb-a">
    a
    <Link to="/zlb/b" data-testid="zlb-to-b" prefetch="none">
      b
    </Link>
  </div>
);

const ZlbB: Handler = () => <div data-testid="zlb-b">b</div>;

export const zeroLoaderBoundaryPatterns = urls(({ layout, path, loading }) => [
  path("/zlb", ZlbHub, { name: "zlbHub" }),
  layout(ZlbLayout, () => [
    loading(<div data-testid="zlb-fallback">zlb-loading</div>),
    path("/zlb/a", ZlbA, { name: "zlbA" }),
    path("/zlb/b", ZlbB, { name: "zlbB" }),
  ]),
]);
