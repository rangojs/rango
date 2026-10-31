import { Breadcrumbs, urls, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { ShoOuterLoader, shoIo } from "./streamed-handle-owner.defs.js";
import { ShoTrail } from "./streamed-handle-owner.client.js";

// A push made after real workerd I/O lands under the segment that made it,
// so the trail reads in segment order (e2e streamed-handle-owner.test.ts):
// - /route: a loading() route pushes after its I/O; its slot pushes at once.
// - /slot: a loading() slot pushes after its I/O, before a sibling slot and
//   the route.
// - /loader: a route's loader() starts another loader after its I/O.

const SHO = "/streamed-handle-owner";

const LINKS: ReadonlyArray<readonly [testId: string, to: string]> = [
  ["sho-link-route", `${SHO}/route`],
  ["sho-link-slot", `${SHO}/slot`],
  ["sho-link-loader", `${SHO}/loader`],
];

const ShoShell: Handler = (ctx) => {
  ctx.use(Breadcrumbs)({ label: "Shell", href: SHO });
  return (
    <section>
      <nav>
        {LINKS.map(([testId, to]) => (
          <Link key={testId} to={to} prefetch="none" data-testid={testId}>
            {to}
          </Link>
        ))}
      </nav>
      <ShoTrail />
      <Outlet />
    </section>
  );
};

function crumb(label: string, href: string): Handler {
  return (ctx) => {
    ctx.use(Breadcrumbs)({ label, href });
    return null;
  };
}

const ShoRoutePage: Handler = async (ctx) => {
  await shoIo(ctx);
  ctx.use(Breadcrumbs)({ label: "Route", href: `${SHO}/route` });
  return <p>route</p>;
};

export const streamedHandleOwnerPatterns = urls(
  ({ layout, path, parallel, loading, loader }) => [
    layout(ShoShell, () => [
      path("/streamed-handle-owner", () => <p>index</p>, {
        name: "streamedHandleOwner",
      }),
      path(
        "/streamed-handle-owner/route",
        ShoRoutePage,
        { name: "streamedHandleOwnerRoute" },
        () => [
          loading(<p>loading</p>),
          parallel({ "@side": crumb("Side", `${SHO}/route#side`) }),
        ],
      ),
      layout(
        () => <Outlet />,
        () => [
          parallel(
            {
              "@a": async (ctx) => {
                await shoIo(ctx);
                ctx.use(Breadcrumbs)({ label: "A", href: `${SHO}/slot#a` });
                return null;
              },
            },
            () => [loading(<p>loading</p>)],
          ),
          parallel({ "@b": crumb("B", `${SHO}/slot#b`) }),
          path(
            "/streamed-handle-owner/slot",
            (ctx) => {
              ctx.use(Breadcrumbs)({ label: "Page", href: `${SHO}/slot` });
              return <p>slot</p>;
            },
            { name: "streamedHandleOwnerSlot" },
          ),
        ],
      ),
      path(
        "/streamed-handle-owner/loader",
        (ctx) => {
          ctx.use(Breadcrumbs)({ label: "Page", href: `${SHO}/loader` });
          return <p>loader</p>;
        },
        { name: "streamedHandleOwnerLoader" },
        () => [
          loader(ShoOuterLoader),
          parallel({ "@side": crumb("Side", `${SHO}/loader#side`) }),
        ],
      ),
    ]),
  ],
);
