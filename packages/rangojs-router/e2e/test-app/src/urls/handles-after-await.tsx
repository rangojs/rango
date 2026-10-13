import {
  Breadcrumbs,
  Meta,
  urls,
  type BreadcrumbItem,
  type Handler,
  type MetaDescriptor,
} from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { Suspense, type ReactNode } from "react";
import {
  HAA_WAIT_MS,
  HaaAwaitLoader,
  wait,
} from "./handles-after-await.defs.js";
import { HaaLoaderView, HaaTrail } from "./handles-after-await.client.js";

// Meta titles and crumbs pushed after `await wait(HAA_WAIT_MS)` from each
// place that holds ctx (e2e handles-after-await.test.ts, scenario in
// tests/shared-e2e/src/handles-after-await-scenario.ts):
// 1. an async route handler (/handler);
// 2. an async layout handler (the layout around /handler and /plain);
// 3. a loader body (/loader, read with useLoader);
// 4. an async server component a route handler (/component) or a layout
//    handler (/component-layout) handed its ctx to;
// 5. the designed path for case 4: the layout and route handlers reserve the
//    slots with .defer(), and an async component resolves them after its
//    await (/defer).
// Run counters show which segments a navigation re-ran.

let awaitLayoutRuns = 0;
let handlerRuns = 0;
let loaderLayoutRuns = 0;
let deferLayoutRuns = 0;

const LINKS: ReadonlyArray<readonly [testId: string, to: string]> = [
  ["haa-link-index", "/handles-after-await"],
  ["haa-link-handler", "/handles-after-await/handler?v=1"],
  ["haa-link-handler-2", "/handles-after-await/handler?v=2"],
  ["haa-link-handler-3", "/handles-after-await/handler?v=3"],
  ["haa-link-plain", "/handles-after-await/plain"],
  ["haa-link-loader-2", "/handles-after-await/loader?v=2"],
  ["haa-link-loader-3", "/handles-after-await/loader?v=3"],
  ["haa-link-component", "/handles-after-await/component"],
  ["haa-link-component-layout", "/handles-after-await/component-layout"],
  ["haa-link-defer-2", "/handles-after-await/defer?v=2"],
  ["haa-link-defer-3", "/handles-after-await/defer?v=3"],
];

function HaaShell() {
  return (
    <section data-testid="haa-shell">
      <nav>
        {LINKS.map(([testId, to]) => (
          <Link key={testId} to={to} prefetch="none" data-testid={testId}>
            {to}
          </Link>
        ))}
      </nav>
      <HaaTrail />
      <Outlet />
    </section>
  );
}

const HaaIndex: Handler = (ctx) => {
  ctx.use(Meta)({ title: "Await Index" });
  ctx.use(Breadcrumbs)({ label: "Await Index", href: "/handles-after-await" });
  return <p data-testid="haa-index">Index</p>;
};

// Case 2: an async layout handler.
const HaaAwaitLayout: Handler = async (ctx) => {
  await wait(HAA_WAIT_MS);
  awaitLayoutRuns += 1;
  ctx.use(Meta)({
    title: { template: "%s · Await Layout", default: "Await Layout" },
  });
  ctx.use(Breadcrumbs)({
    label: "Await Layout",
    href: "/handles-after-await/layout",
  });
  return (
    <div data-testid="haa-await-layout">
      <span data-testid="haa-layout-run">{`layout run ${awaitLayoutRuns}`}</span>
      <Outlet />
    </div>
  );
};

// Case 1: an async route handler.
const HaaHandlerPage: Handler = async (ctx) => {
  const v = ctx.searchParams.get("v") ?? "1";
  await wait(HAA_WAIT_MS);
  handlerRuns += 1;
  ctx.use(Meta)({ title: `Handler ${v}` });
  ctx.use(Breadcrumbs)({
    label: `Handler ${v}`,
    href: "/handles-after-await/handler",
  });
  return <p data-testid="haa-handler">{`handler ${v} run ${handlerRuns}`}</p>;
};

const HaaPlainPage: Handler = (ctx) => {
  ctx.use(Meta)({ title: "Plain" });
  ctx.use(Breadcrumbs)({ label: "Plain", href: "/handles-after-await/plain" });
  return <p data-testid="haa-plain">Plain</p>;
};

// Case 3's layout: synchronous, so the loader's push races only the route
// handler.
const HaaLoaderLayout: Handler = (ctx) => {
  loaderLayoutRuns += 1;
  ctx.use(Meta)({
    title: { template: "%s · Loader Layout", default: "Loader Layout" },
  });
  ctx.use(Breadcrumbs)({
    label: "Loader Layout",
    href: "/handles-after-await/loader-layout",
  });
  return (
    <div data-testid="haa-loader-layout">
      <span data-testid="haa-loader-layout-run">{`loader layout run ${loaderLayoutRuns}`}</span>
      <Outlet />
    </div>
  );
};

// Case 4: an async server component that pushes with the ctx it was handed.
async function HaaAwaitPush({
  ctx,
  label,
}: {
  ctx: Parameters<Handler>[0];
  label: string;
}) {
  await wait(HAA_WAIT_MS);
  ctx.use(Meta)({ title: label });
  ctx.use(Breadcrumbs)({
    label,
    href: `/handles-after-await/${label.toLowerCase().replace(/ /g, "-")}`,
  });
  return <p data-testid="haa-component">{label}</p>;
}

// Case 5: the handler reserves a title slot and a crumb slot; the async
// component it renders closes over the resolvers and resolves them after its
// await.
function resolveAfterAwait(
  ctx: Parameters<Handler>[0],
  title: MetaDescriptor,
  crumb: BreadcrumbItem,
): ReactNode {
  const resolveTitle = ctx.use(Meta).defer({ timeoutMs: 5000, else: null });
  const resolveCrumb = ctx
    .use(Breadcrumbs)
    .defer({ timeoutMs: 5000, else: null });
  async function HaaDeferNav() {
    await wait(HAA_WAIT_MS);
    resolveTitle(title);
    resolveCrumb(crumb);
    return null;
  }
  return (
    <Suspense fallback={null}>
      <HaaDeferNav />
    </Suspense>
  );
}

const HaaDeferLayout: Handler = (ctx) => {
  deferLayoutRuns += 1;
  return (
    <div data-testid="haa-defer-layout">
      <span data-testid="haa-defer-layout-run">{`defer layout run ${deferLayoutRuns}`}</span>
      {resolveAfterAwait(
        ctx,
        { title: { template: "%s · Defer Layout", default: "Defer Layout" } },
        { label: "Defer Layout", href: "/handles-after-await/defer-layout" },
      )}
      <Outlet />
    </div>
  );
};

const HaaDeferPage: Handler = (ctx) => {
  const v = ctx.searchParams.get("v") ?? "1";
  return (
    <div data-testid="haa-defer-page">
      {`defer ${v}`}
      {resolveAfterAwait(
        ctx,
        { title: `Defer ${v}` },
        { label: `Defer ${v}`, href: "/handles-after-await/defer" },
      )}
    </div>
  );
};

export const handlesAfterAwaitPatterns = urls(({ layout, path, loader }) => [
  layout(HaaShell, () => [
    path("/handles-after-await", HaaIndex, { name: "handlesAfterAwait" }),
    layout(HaaAwaitLayout, () => [
      path("/handles-after-await/handler", HaaHandlerPage, {
        name: "handlesAfterAwaitHandler",
      }),
      path("/handles-after-await/plain", HaaPlainPage, {
        name: "handlesAfterAwaitPlain",
      }),
    ]),
    layout(HaaLoaderLayout, () => [
      path(
        "/handles-after-await/loader",
        () => <HaaLoaderView />,
        { name: "handlesAfterAwaitLoader" },
        () => [loader(HaaAwaitLoader)],
      ),
    ]),
    path(
      "/handles-after-await/component",
      (ctx) => <HaaAwaitPush ctx={ctx} label="Component" />,
      { name: "handlesAfterAwaitComponent" },
    ),
    layout(
      (ctx) => (
        <div data-testid="haa-component-layout">
          <HaaAwaitPush ctx={ctx} label="Component Layout" />
          <Outlet />
        </div>
      ),
      () => [
        path(
          "/handles-after-await/component-layout",
          () => <p data-testid="haa-component-layout-page">Page</p>,
          { name: "handlesAfterAwaitComponentLayout" },
        ),
      ],
    ),
    layout(HaaDeferLayout, () => [
      path("/handles-after-await/defer", HaaDeferPage, {
        name: "handlesAfterAwaitDefer",
      }),
    ]),
  ]),
]);
