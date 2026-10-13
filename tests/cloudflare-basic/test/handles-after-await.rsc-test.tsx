// Dogfood: a Meta title and a Breadcrumbs crumb pushed after an await, from
// an async route handler, an async layout handler and a loader body, and
// reserved with .defer() in the handlers and resolved by an async component
// after its await, through serveShellRequest (the router's production request handler, real Flight).
// readHandles() decodes the handle data as the browser reads it: `hydration`
// is what the document hydrates with, `late` what the late channel applies
// after hydration. The browser half, with the owner's 1000 ms wait and the
// async-component case, is e2e/handles-after-await.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import {
  Breadcrumbs,
  createLoader,
  createRouter,
  Meta,
  urls,
  type BreadcrumbItem,
  type Handler,
  type MetaDescriptor,
} from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { Suspense, type ReactNode } from "react";
import { collectHandle } from "@rangojs/router/testing";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
  type ShellRequestHandles,
} from "@rangojs/router/testing/flight";

const WAIT_MS = 50;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const runs = {
  layout: 0,
  handler: 0,
  loaderLayout: 0,
  loader: 0,
  deferLayout: 0,
};

const AwaitLayout: Handler = async (ctx) => {
  await wait(WAIT_MS);
  runs.layout += 1;
  ctx.use(Meta)({
    title: { template: "%s · Await Layout", default: "Await Layout" },
  });
  ctx.use(Breadcrumbs)({ label: "Await Layout", href: "/haa/layout" });
  return <Outlet />;
};

const AwaitHandler: Handler = async (ctx) => {
  const v = ctx.searchParams.get("v") ?? "1";
  await wait(WAIT_MS);
  runs.handler += 1;
  ctx.use(Meta)({ title: `Handler ${v}` });
  ctx.use(Breadcrumbs)({ label: `Handler ${v}`, href: "/haa/handler" });
  return <p>{`handler ${v}`}</p>;
};

const LoaderLayout: Handler = (ctx) => {
  runs.loaderLayout += 1;
  ctx.use(Meta)({
    title: { template: "%s · Loader Layout", default: "Loader Layout" },
  });
  ctx.use(Breadcrumbs)({ label: "Loader Layout", href: "/haa/loader-layout" });
  return <Outlet />;
};

const AwaitLoader = createLoader(async (ctx) => {
  const v = ctx.searchParams.get("v") ?? "1";
  await wait(WAIT_MS);
  runs.loader += 1;
  ctx.use(Meta)({ title: `Loader ${v}` });
  ctx.use(Breadcrumbs)({ label: `Loader ${v}`, href: "/haa/loader" });
  return { v };
});

/** Reserves both slots now; an async component resolves them after its await. */
function resolveAfterAwait(
  ctx: Parameters<Handler>[0],
  title: MetaDescriptor,
  crumb: BreadcrumbItem,
): ReactNode {
  const resolveTitle = ctx.use(Meta).defer({ timeoutMs: 5000, else: null });
  const resolveCrumb = ctx
    .use(Breadcrumbs)
    .defer({ timeoutMs: 5000, else: null });
  async function DeferNav() {
    await wait(WAIT_MS);
    resolveTitle(title);
    resolveCrumb(crumb);
    return null;
  }
  return (
    <Suspense fallback={null}>
      <DeferNav />
    </Suspense>
  );
}

const DeferLayout: Handler = (ctx) => {
  runs.deferLayout += 1;
  return (
    <>
      {resolveAfterAwait(
        ctx,
        { title: { template: "%s · Defer Layout", default: "Defer Layout" } },
        { label: "Defer Layout", href: "/haa/defer-layout" },
      )}
      <Outlet />
    </>
  );
};

const DeferPage: Handler = (ctx) => {
  const v = ctx.searchParams.get("v") ?? "1";
  return resolveAfterAwait(
    ctx,
    { title: `Defer ${v}` },
    { label: `Defer ${v}`, href: "/haa/defer" },
  );
};

const router = createRouter({ id: "cf-handles-after-await" }).routes(
  urls(({ layout, path, loader }) => [
    layout(AwaitLayout, () => [
      path("/haa/handler", AwaitHandler, { name: "haaHandler" }),
    ]),
    layout(LoaderLayout, () => [
      path(
        "/haa/loader",
        () => <p>loader page</p>,
        { name: "haaLoader" },
        () => [loader(AwaitLoader)],
      ),
    ]),
    layout(DeferLayout, () => [
      path("/haa/defer", DeferPage, { name: "haaDefer" }),
    ]),
  ]),
);

beforeEach(async () => {
  await resetShellTestState();
  runs.layout = runs.handler = runs.loaderLayout = runs.loader = 0;
  runs.deferLayout = 0;
});

type HandleData = ShellRequestHandles["hydration"];

/** What the page shows from one handle state: the title and the crumbs. */
function shown(data: HandleData | undefined): {
  title: string | undefined;
  crumbs: string[];
} {
  const meta = collectHandle(
    Meta,
    Object.values(data?.[Meta.$$id] ?? {}) as MetaDescriptor[][],
  );
  const crumbs = collectHandle(
    Breadcrumbs,
    Object.values(data?.[Breadcrumbs.$$id] ?? {}) as BreadcrumbItem[][],
  );
  const title = meta.find(
    (descriptor): descriptor is { title: string } => "title" in descriptor,
  )?.title;
  return { title, crumbs: crumbs.map((crumb) => crumb.label) };
}

/** The segment ids a handle state carries a bucket for. */
function bucketsOf(data: HandleData | undefined): string[] {
  return Object.keys(data?.[Breadcrumbs.$$id] ?? {});
}

function matchedOf(result: ServeShellRequestResult): string[] {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  if (!row) throw new Error("no Flight payload");
  return JSON.parse(row.slice(2)).metadata.matched;
}

describe("handles pushed after an await (cloudflare-basic)", () => {
  it("an async layout handler's and an async route handler's pushes are in the document's handle data, layout first", async () => {
    const result = await serveShellRequest(router, "/haa/handler?v=1");
    const handles = await result.readHandles();

    expect(shown(handles?.hydration)).toEqual({
      title: "Handler 1 · Await Layout",
      crumbs: ["Await Layout", "Handler 1"],
    });
    expect(handles?.late).toEqual([]);
  });

  it("a navigation that re-runs only the route handler carries only the route's pushes; the held layout's stay on the client", async () => {
    const page = await serveShellRequest(router, "/haa/handler?v=1");
    const [layoutId, routeId] = bucketsOf(
      (await page.readHandles())?.hydration,
    );
    expect(runs).toMatchObject({ layout: 1, handler: 1 });

    const nav = await serveShellRequest(router, "/haa/handler?v=2", {
      partial: { from: "/haa/handler?v=1", segments: matchedOf(page) },
    });
    const handles = await nav.readHandles();

    expect(runs).toMatchObject({ layout: 1, handler: 2 });
    expect(bucketsOf(handles?.hydration)).toEqual([routeId]);
    expect(layoutId).not.toBe(routeId);
    expect(shown(handles?.hydration)).toEqual({
      title: "Handler 2",
      crumbs: ["Handler 2"],
    });
  });

  it("a loader's pushes after its await miss the document's handle data and arrive on the late channel", async () => {
    const result = await serveShellRequest(router, "/haa/loader?v=1");
    const handles = await result.readHandles();

    expect(shown(handles?.hydration)).toEqual({
      title: "Loader Layout",
      crumbs: ["Loader Layout"],
    });
    expect(shown(handles?.late.at(-1))).toEqual({
      title: "Loader 1 · Loader Layout",
      crumbs: ["Loader Layout", "Loader 1"],
    });
  });

  it("a navigation that re-runs the loader, not its layout, carries the loader's new pushes in the route's bucket", async () => {
    const page = await serveShellRequest(router, "/haa/loader?v=1");
    const [, routeId] = bucketsOf((await page.readHandles())?.late.at(-1));
    expect(runs).toMatchObject({ loaderLayout: 1, loader: 1 });

    const nav = await serveShellRequest(router, "/haa/loader?v=2", {
      partial: { from: "/haa/loader?v=1", segments: matchedOf(page) },
    });
    const handles = await nav.readHandles();

    expect(runs).toMatchObject({ loaderLayout: 1, loader: 2 });
    expect(bucketsOf(handles?.hydration)).toEqual([routeId]);
    expect(shown(handles?.hydration)).toEqual({
      title: "Loader 2",
      crumbs: ["Loader 2"],
    });
  });

  it("titles and crumbs reserved with .defer() and resolved by an async component after its await are resolved in the document's handle data", async () => {
    const result = await serveShellRequest(router, "/haa/defer?v=1");
    const handles = await result.readHandles();

    expect(shown(handles?.hydration)).toEqual({
      title: "Defer 1 · Defer Layout",
      crumbs: ["Defer Layout", "Defer 1"],
    });
    expect(handles?.late).toEqual([]);
  });

  it("a navigation that re-runs only the route handler carries its resolved deferred pushes in the route's bucket; the held layout's stay on the client", async () => {
    const page = await serveShellRequest(router, "/haa/defer?v=1");
    const [, routeId] = bucketsOf((await page.readHandles())?.hydration);
    expect(runs.deferLayout).toBe(1);

    const nav = await serveShellRequest(router, "/haa/defer?v=2", {
      partial: { from: "/haa/defer?v=1", segments: matchedOf(page) },
    });
    const handles = await nav.readHandles();

    expect(runs.deferLayout).toBe(1);
    expect(bucketsOf(handles?.hydration)).toEqual([routeId]);
    expect(shown(handles?.hydration)).toEqual({
      title: "Defer 2",
      crumbs: ["Defer 2"],
    });
  });
});
