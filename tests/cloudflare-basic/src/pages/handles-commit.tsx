import { Breadcrumbs, Meta, urls, type HandlerContext } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { HcTrail } from "./handles-commit.client.js";

// Cloudflare-basic mirror of the router e2e app's /handles-commit/* fixture
// (urls/handles-commit.tsx). A navigation's title and crumbs commit with its
// page (e2e handles-commit.test.ts, scenario in
// tests/shared-e2e/src/handles-commit-scenario.ts). Every request waits
// HC_SERVER_DELAY first, as a real server would.
// - /handles-commit/held/:id, held-novt/:id: the handler pushes, then waits
//   800 ms before it returns the page, so the handles reach the client long
//   before the page under loading() and transition() (with and without the
//   router's <ViewTransition>).
// - /handles-commit/stream/:boundary/:id, stream-vt/...: the page renders at
//   once; its crumb's content resolves 2 s later, read with use() in
//   <Suspense>. boundary "same" keeps the crumb href (and so its boundary)
//   across pages, "keyed" gives each page its own.

const HC_SERVER_DELAY = 400;
const HC_HANDLER_WAIT = 800;
const HC_CONTENT_WAIT = 2000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function hcServerDelay(_ctx: unknown, next: () => Promise<Response>) {
  await wait(HC_SERVER_DELAY);
  return next();
}

function HcLinks({ base }: { base: string }) {
  return (
    <nav>
      {["1", "2", "3"].map((id) => (
        <Link
          key={id}
          to={`${base}/${id}`}
          prefetch="none"
          data-testid={`hc-link-${id}`}
        >
          {id}
        </Link>
      ))}
    </nav>
  );
}

async function HeldPage(ctx: HandlerContext<{ id: string }>) {
  const variant = ctx.url.pathname.split("/")[2]!;
  const { id } = ctx.params;
  ctx.use(Meta)({ title: `HC ${variant} ${id}` });
  ctx.use(Breadcrumbs)({
    label: `${variant} ${id}`,
    href: `/handles-commit/${variant}/${id}`,
  });
  await wait(HC_HANDLER_WAIT);
  return (
    <section>
      <p data-testid="hc-page">{`${variant} ${id}`}</p>
      <HcLinks base={`/handles-commit/${variant}`} />
    </section>
  );
}

function StreamPage(ctx: HandlerContext<{ boundary: string; id: string }>) {
  const variant = ctx.url.pathname.split("/")[2]!;
  const { boundary, id } = ctx.params;
  ctx.use(Meta)({ title: `HC ${variant} ${boundary} ${id}` });
  ctx.use(Breadcrumbs)({
    label: `${boundary} ${id}`,
    href:
      boundary === "keyed"
        ? `/handles-commit/stock/${id}`
        : "/handles-commit/stock",
    content: wait(HC_CONTENT_WAIT).then(() => (
      <span data-testid="hc-crumb-content">{`stock ${id}`}</span>
    )),
  });
  return (
    <section>
      <p data-testid="hc-page">{`${boundary} ${id}`}</p>
      <HcLinks base={`/handles-commit/${variant}/${boundary}`} />
    </section>
  );
}

export const handlesCommitPatterns = urls(
  ({ path, layout, loading, middleware, transition }) => [
    layout(
      (ctx) => {
        ctx.use(Breadcrumbs)({
          label: "Handles commit",
          href: "/handles-commit",
        });
        return (
          <div data-testid="hc-shell">
            <HcTrail />
            <Outlet />
          </div>
        );
      },
      () => [
        middleware(hcServerDelay),
        path("/handles-commit/held/:id", HeldPage, { name: "hcHeld" }, () => [
          loading(<p data-testid="hc-loading">loading</p>),
          transition(),
        ]),
        path(
          "/handles-commit/held-novt/:id",
          HeldPage,
          { name: "hcHeldNovt" },
          () => [
            loading(<p data-testid="hc-loading">loading</p>),
            transition({ viewTransition: false }),
          ],
        ),
        path("/handles-commit/stream/:boundary/:id", StreamPage, {
          name: "hcStream",
        }),
        path(
          "/handles-commit/stream-vt/:boundary/:id",
          StreamPage,
          { name: "hcStreamVt" },
          () => [transition()],
        ),
      ],
    ),
  ],
);
