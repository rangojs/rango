import { Breadcrumbs, Meta, urls, type HandlerContext } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import {
  AhPathTitleEffect,
  AhTitleEffect,
  AhTrail,
} from "./async-handles.client.js";

// Async handle values (e2e async-handles.test.ts, scenario in
// tests/shared-e2e/src/async-handles-scenario.ts). A handle pushed with a
// promise (or an async function) is awaited during SSR and held then swapped
// on a client navigation. Every request waits AH_SERVER_DELAY first.
// - /async-handles/urgent/:id, transition/:id: the page returns at once;
//   Meta(promise) and Breadcrumbs(promise) resolve AH_HANDLE_WAIT later.
// - /async-handles/fn/:id: Breadcrumbs(async () => item).
// - /async-handles/sync/:id: plain (sync) Meta and Breadcrumbs.
// - /async-handles/late/:id: the promises resolve AH_LATE_WAIT after the page.

const AH_SERVER_DELAY = 400;
const AH_HANDLE_WAIT = 800;
const AH_LATE_WAIT = 2500;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ahServerDelay(_ctx: unknown, next: () => Promise<Response>) {
  await wait(AH_SERVER_DELAY);
  return next();
}

function AhPage(ctx: HandlerContext<{ id: string }>) {
  const variant = ctx.url.pathname.split("/")[2]!;
  const { id } = ctx.params;
  const label = `${variant} ${id}`;
  const href = `/async-handles/${variant}/${id}`;
  if (variant === "fn") {
    ctx.use(Meta)({ title: `AH ${label}` });
    ctx.use(Breadcrumbs)(async () => {
      await wait(AH_HANDLE_WAIT);
      return { label, href };
    });
  } else if (variant === "sync") {
    ctx.use(Meta)({ title: `AH ${label}` });
    ctx.use(Breadcrumbs)({ label, href });
  } else {
    const ms = variant === "late" ? AH_LATE_WAIT : AH_HANDLE_WAIT;
    ctx.use(Meta)(wait(ms).then(() => ({ title: `AH ${label}` })));
    ctx.use(Breadcrumbs)(wait(ms).then(() => ({ label, href })));
  }
  return (
    <section>
      <p data-testid="ah-page">{label}</p>
      <nav>
        {["1", "2"].map((n) => (
          <Link
            key={n}
            to={`/async-handles/${variant}/${n}`}
            prefetch="none"
            data-testid={`ah-link-${n}`}
          >
            {n}
          </Link>
        ))}
      </nav>
    </section>
  );
}

export const asyncHandlesPatterns = urls(
  ({ path, layout, middleware, transition }) => [
    layout(
      () => (
        <div data-testid="ah-shell">
          <AhTrail />
          <AhTitleEffect />
          <AhPathTitleEffect />
          <Outlet />
        </div>
      ),
      () => [
        middleware(ahServerDelay),
        path("/async-handles/urgent/:id", AhPage),
        path("/async-handles/fn/:id", AhPage),
        path("/async-handles/sync/:id", AhPage),
        path("/async-handles/late/:id", AhPage),
        path("/async-handles/transition/:id", AhPage, () => [transition()]),
      ],
    ),
  ],
);
