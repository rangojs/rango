import { urls, Breadcrumbs } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function DelayedBreadcrumbLayout({ ctx }: { ctx: any }) {
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  await sleep(40);
  pushBreadcrumb({
    label: "Delayed Layout",
    href: "/delayed-breadcrumbs",
  });

  return (
    <div data-testid="delayed-breadcrumb-layout">
      <Outlet />
    </div>
  );
}

async function DelayedBreadcrumbPage({ ctx }: { ctx: any }) {
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  await sleep(40);
  pushBreadcrumb({
    label: "Delayed Page",
    href: "/delayed-breadcrumbs",
  });

  return (
    <div data-testid="delayed-breadcrumb-page">
      <Link to="/" data-testid="delayed-breadcrumb-home-link">
        Back Home
      </Link>
      <h1>Delayed Breadcrumb Page</h1>
    </div>
  );
}

export const delayedBreadcrumbPatterns = urls(({ layout, path }) => [
  layout(
    (ctx) => <DelayedBreadcrumbLayout ctx={ctx} />,
    () => [
      path(
        "/delayed-breadcrumbs",
        (ctx) => <DelayedBreadcrumbPage ctx={ctx} />,
        {
          name: "delayedBreadcrumbs",
        },
      ),
    ],
  ),
]);
