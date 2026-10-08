import { urls, createLoader } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { BaseCostValue } from "../components/BaseCost.js";

const run20 = async () => {
  await new Promise((r) => setTimeout(r, 20));
  return { delay: 20 };
};
export const Bc3WlLoader = createLoader(run20);
export const Bc3SlotLoader = createLoader(run20);
export const Bc3RsALoader = createLoader(run20);
export const Bc3RsBLoader = createLoader(run20);

const fb = (id: string) => <div data-testid={id}>loading {id}</div>;
const ROUTES = ["wl/a", "wl/b", "slot/a", "slot/b", "rs/a", "rs/b"];

function make(prefix: string, prefetchA: boolean) {
  const Hub = () => (
    <div data-testid="bc-hub">
      {ROUTES.map((r) => (
        <Link
          key={r}
          to={`${prefix}/${r}`}
          prefetch={prefetchA && r.endsWith("/a") ? "render" : "none"}
          data-testid={`bc3-link-${r.replace("/", "-")}`}
        >
          {r}
        </Link>
      ))}
      <div data-testid="bc-outlet">
        <Outlet />
      </div>
    </div>
  );
  const WlLayout = () => (
    <div data-testid="bc3-wl-layout">
      <BaseCostValue loader={Bc3WlLoader} testId="bc3-wl-value" />
      <Outlet />
    </div>
  );
  const SlotLayout = () => (
    <div data-testid="bc3-slot-layout">
      <Outlet />
      <ParallelOutlet name="@side" />
    </div>
  );
  const Side = () => (
    <aside>
      <BaseCostValue loader={Bc3SlotLoader} testId="bc3-slot-value" />
    </aside>
  );
  const RsLayout = () => (
    <div data-testid="bc3-rs-layout">
      <Outlet />
    </div>
  );
  const pg = (id: string) => () => <div data-testid={id}>{id}</div>;
  return urls(({ path, layout, loader, loading, parallel }) => [
    layout(Hub, () => [
      path("/", () => <div data-testid="bc-index">hub</div>, { name: "index" }),
      layout(WlLayout, () => [
        loader(Bc3WlLoader),
        loading(fb("bc3-fb-outer")),
        path("/wl/a", pg("bc3-wl-a"), { name: "wlA" }),
        path("/wl/b", pg("bc3-wl-b"), { name: "wlB" }),
      ]),
      layout(SlotLayout, () => [
        parallel({ "@side": Side }, () => [
          loader(Bc3SlotLoader),
          loading(fb("bc3-fb-slot")),
        ]),
        path("/slot/a", pg("bc3-slot-a"), { name: "slotA" }),
        path("/slot/b", pg("bc3-slot-b"), { name: "slotB" }),
      ]),
      layout(RsLayout, () => [
        path(
          "/rs/a",
          () => (
            <div data-testid="bc3-rs-a">
              <BaseCostValue loader={Bc3RsALoader} testId="bc3-rs-a-value" />
            </div>
          ),
          { name: "rsA" },
          () => [loader(Bc3RsALoader), loading(fb("bc3-fb-rs-a"))],
        ),
        path(
          "/rs/b",
          () => (
            <div data-testid="bc3-rs-b">
              <BaseCostValue loader={Bc3RsBLoader} testId="bc3-rs-b-value" />
            </div>
          ),
          { name: "rsB" },
          () => [loader(Bc3RsBLoader), loading(fb("bc3-fb-rs-b"))],
        ),
      ]),
    ]),
  ]);
}

export const bc3QPatterns = make("/bc3-q", true);
export const bc3APatterns = make("/bc3-a", false);
