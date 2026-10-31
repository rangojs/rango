import { Breadcrumbs, urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  SHO_WAITS,
  ShoOuterLoader,
  shoPause,
} from "./streamed-handle-owner.defs.js";
import { ShoTrail } from "./streamed-handle-owner.client.js";

// A push made after a short await (:wait is "microtasks" or "timer",
// shoPause) lands under the segment that made it, so the trail reads in
// segment order (e2e streamed-handle-owner.test.ts):
// - /:wait/route: a loading() route pushes after its await; its slot pushes
//   at once.
// - /:wait/slot: a loading() slot pushes after its await, before a sibling
//   slot and the route.
// - /:wait/loader: a route's loader() starts another loader after its await.

const SHO = "/streamed-handle-owner";

type WaitParams = { wait: string };

const ShoShell: Handler = (ctx) => {
  ctx.use(Breadcrumbs)({ label: "Shell", href: SHO });
  return (
    <section>
      <nav>
        {SHO_WAITS.flatMap((wait) =>
          ["route", "slot", "loader"].map((page) => (
            <Link
              key={`${wait}-${page}`}
              to={`${SHO}/${wait}/${page}`}
              prefetch="none"
              data-testid={`sho-link-${wait}-${page}`}
            >
              {`${wait} ${page}`}
            </Link>
          )),
        )}
      </nav>
      <ShoTrail />
      <Outlet />
    </section>
  );
};

function crumb(label: string, page: string): Handler<WaitParams> {
  return (ctx) => {
    ctx.use(Breadcrumbs)({
      label,
      href: `${SHO}/${ctx.params.wait}/${page}`,
    });
    return null;
  };
}

const ShoRoutePage: Handler<WaitParams> = async (ctx) => {
  await shoPause(ctx.params.wait);
  ctx.use(Breadcrumbs)({
    label: "Route",
    href: `${SHO}/${ctx.params.wait}/route`,
  });
  return <p>route</p>;
};

const ShoSlotA: Handler<WaitParams> = async (ctx) => {
  await shoPause(ctx.params.wait);
  ctx.use(Breadcrumbs)({
    label: "A",
    href: `${SHO}/${ctx.params.wait}/slot#a`,
  });
  return null;
};

export const streamedHandleOwnerPatterns = urls(
  ({ layout, path, parallel, loading, loader }) => [
    layout(ShoShell, () => [
      path("/streamed-handle-owner", () => <p>index</p>, {
        name: "streamedHandleOwner",
      }),
      path(
        "/streamed-handle-owner/:wait/route",
        ShoRoutePage,
        { name: "streamedHandleOwnerRoute" },
        () => [
          loading(<p>loading</p>),
          parallel({ "@side": crumb("Side", "route#side") }),
        ],
      ),
      layout(
        () => <Outlet />,
        () => [
          parallel({ "@a": ShoSlotA }, () => [loading(<p>loading</p>)]),
          parallel({ "@b": crumb("B", "slot#b") }),
          path("/streamed-handle-owner/:wait/slot", crumb("Page", "slot"), {
            name: "streamedHandleOwnerSlot",
          }),
        ],
      ),
      path(
        "/streamed-handle-owner/:wait/loader",
        crumb("Page", "loader"),
        { name: "streamedHandleOwnerLoader" },
        () => [
          loader(ShoOuterLoader),
          parallel({ "@side": crumb("Side", "loader#side") }),
        ],
      ),
    ]),
  ],
);
