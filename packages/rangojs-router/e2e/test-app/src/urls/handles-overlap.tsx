import { Breadcrumbs, Meta, urls, type HandlerContext } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { HO_CRUMB_HREF, HoTrail } from "./handles-overlap.client.js";

// A second click over a held transition() page (e2e handles-overlap.test.ts,
// scenario in tests/shared-e2e/src/handles-overlap-scenario.ts; hook lock
// rows HD2, HD4 and HD13). Every request waits HO_SERVER_DELAY first, as a
// real server would.
// /handles-overlap/:reader/:vt/:id: `reader` picks the crumb reader in the
// layout (multi: useHandle, useSegments and usePathname; full: useHandle;
// select: useHandle with a selector), `vt` the route's transition() (vt:
// with the router's <ViewTransition>; novt: viewTransition: false). Every
// page's crumb has the same href, so the crumb's content <Suspense> stays
// mounted and revealed across pages. Every page pushes its title and crumb
// first.
// - 1: the page a test starts on.
// - held, held-pending: the page returns HO_HOLD ms later, so its handles
//   reach the client long before it. held-pending's crumb content resolves
//   HO_LONG_WAIT after the request.
// - fast: the page returns at once; its handles stream with it.
// - fast-pending: the page returns HO_SETTLE ms later, after its handles;
//   its crumb content resolves HO_CONTENT_WAIT after the request.

const HO_SERVER_DELAY = 400;
const HO_HOLD = 3000;
const HO_SETTLE = 150;
const HO_CONTENT_WAIT = 2500;
const HO_LONG_WAIT = 6000;
const HO_PAGES = ["1", "held", "held-pending", "fast", "fast-pending"];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function hoServerDelay(_ctx: unknown, next: () => Promise<Response>) {
  await wait(HO_SERVER_DELAY);
  return next();
}

function crumbContent(id: string) {
  const content = <span>{`c ${id}`}</span>;
  if (id === "fast-pending") return wait(HO_CONTENT_WAIT).then(() => content);
  if (id === "held-pending") return wait(HO_LONG_WAIT).then(() => content);
  return content;
}

async function HoPage(ctx: HandlerContext<{ id: string }>) {
  const base = ctx.url.pathname.split("/").slice(0, 4).join("/");
  const { id } = ctx.params;
  ctx.use(Meta)({ title: `HO ${id}` });
  ctx.use(Breadcrumbs)({
    label: id,
    href: HO_CRUMB_HREF,
    content: crumbContent(id),
  });
  if (id.startsWith("held")) await wait(HO_HOLD);
  if (id === "fast-pending") await wait(HO_SETTLE);
  return (
    <section>
      <p data-testid="ho-page">{id}</p>
      <nav>
        {HO_PAGES.map((page) => (
          <Link
            key={page}
            to={`${base}/${page}`}
            prefetch="none"
            data-testid={`ho-link-${page}`}
          >
            {page}
          </Link>
        ))}
      </nav>
    </section>
  );
}

function HoShell({ reader }: { reader: "multi" | "full" | "select" }) {
  return (
    <div data-testid="ho-shell">
      <HoTrail reader={reader} />
      <Outlet />
    </div>
  );
}

const hoLoading = <p data-testid="ho-loading">loading</p>;

export const handlesOverlapPatterns = urls(
  ({ path, layout, loading, middleware, transition }) => [
    layout(<HoShell reader="multi" />, () => [
      middleware(hoServerDelay),
      path(
        "/handles-overlap/multi/vt/:id",
        HoPage,
        { name: "hoMultiVt" },
        () => [loading(hoLoading), transition()],
      ),
      path(
        "/handles-overlap/multi/novt/:id",
        HoPage,
        { name: "hoMultiNovt" },
        () => [loading(hoLoading), transition({ viewTransition: false })],
      ),
    ]),
    layout(<HoShell reader="full" />, () => [
      middleware(hoServerDelay),
      path("/handles-overlap/full/vt/:id", HoPage, { name: "hoFullVt" }, () => [
        loading(hoLoading),
        transition(),
      ]),
      path(
        "/handles-overlap/full/novt/:id",
        HoPage,
        { name: "hoFullNovt" },
        () => [loading(hoLoading), transition({ viewTransition: false })],
      ),
    ]),
    layout(<HoShell reader="select" />, () => [
      middleware(hoServerDelay),
      path(
        "/handles-overlap/select/vt/:id",
        HoPage,
        { name: "hoSelectVt" },
        () => [loading(hoLoading), transition()],
      ),
      path(
        "/handles-overlap/select/novt/:id",
        HoPage,
        { name: "hoSelectNovt" },
        () => [loading(hoLoading), transition({ viewTransition: false })],
      ),
    ]),
  ],
);
