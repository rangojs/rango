/**
 * A Prerender route's build files a layout's handle pushes under that layout
 * when the layout is declared inside the route and owns loaders, as a live
 * render does. The build pass skips loaders (`skipLoaders`); it used to skip
 * resolveOwnerLoaders' `_currentSegmentId` pin with them, so the layout's
 * handler pushed under the route's segment and the baked handles came in
 * another order than a live render's. A layout with no loader had no pin at
 * all until resolveOrphanLayout pinned its own id before its handler.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
  const clientManifest = new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key === "string"
          ? { id: key.split("#")[0], chunks: [], name: key.split("#")[1] }
          : undefined,
    },
  );
  return {
    createTemporaryReferenceSet: () => new WeakMap(),
    renderToReadableStream: (value: unknown, options?: object) =>
      RSD.renderToReadableStream(value, clientManifest, options),
  };
});
vi.mock("@vitejs/plugin-rsc/rsc/client", async () => {
  await import("../../testing/internal/flight-client-globals.js");
  const { createFromReadableStream } =
    await import("@vitejs/plugin-rsc/react/browser");
  return {
    createFromReadableStream: (stream: ReadableStream<Uint8Array>) =>
      createFromReadableStream(stream),
  };
});

import { createRouter } from "../../router.js";
import { Prerender } from "../../prerender.js";
import { createHandle } from "../../handle.js";
import { createLoader } from "../../loader.rsc.js";
import { deserializeResult } from "../../cache/segment-codec.js";

const Crumbs = createHandle<string>(undefined, "test#Crumbs");
const PageData = createLoader(async () => ({ page: true }));
const AsideData = createLoader(async () => ({ aside: true }));

const router: any = createRouter<Record<string, never>>({}).routes(
  ({ path, layout, loader }: any) => [
    layout(<div>shell</div>, () => [
      path(
        "/page",
        Prerender((ctx: any) => {
          ctx.use(Crumbs)("page-crumb");
          return <p>page</p>;
        }),
        { name: "page" },
        () => [
          loader(PageData),
          layout(
            (ctx: any) => {
              ctx.use(Crumbs)("aside-crumb");
              return <aside>aside</aside>;
            },
            () => [loader(AsideData)],
          ),
        ],
      ),
    ]),
  ],
);

describe("matchForPrerender: a layout declared inside the route that owns loaders", () => {
  it("files its handler's pushes under its own segment", async () => {
    const result = await router.matchForPrerender("/page", {});
    const handles = await deserializeResult<
      Record<string, Record<string, string[]>>
    >(result.handles);
    const ids: string[] = result.segments.map((s: any) => s.metadata.id);
    const page = ids.find((id) => id.endsWith("R0"))!;
    const aside = ids.find((id) => id === `${page}L0`)!;
    expect(handles).toEqual({
      [aside]: { "test#Crumbs": ["aside-crumb"] },
      [page]: { "test#Crumbs": ["page-crumb"] },
    });
  });
});

const bareRouter: any = createRouter<Record<string, never>>({}).routes(
  ({ path, layout }: any) => [
    layout(<div>shell</div>, () => [
      path(
        "/page",
        Prerender((ctx: any) => {
          ctx.use(Crumbs)("page-crumb");
          return <p>page</p>;
        }),
        { name: "page" },
        () => [
          layout((ctx: any) => {
            ctx.use(Crumbs)("aside-crumb");
            return <aside>aside</aside>;
          }),
        ],
      ),
    ]),
  ],
);

describe("matchForPrerender: a layout declared inside the route with no loader", () => {
  it("files its handler's pushes under its own segment", async () => {
    const result = await bareRouter.matchForPrerender("/page", {});
    const handles = await deserializeResult<
      Record<string, Record<string, string[]>>
    >(result.handles);
    const ids: string[] = result.segments.map((s: any) => s.metadata.id);
    const page = ids.find((id) => id.endsWith("R0"))!;
    const aside = ids.find((id) => id === `${page}L0`)!;
    expect(handles).toEqual({
      [aside]: { "test#Crumbs": ["aside-crumb"] },
      [page]: { "test#Crumbs": ["page-crumb"] },
    });
  });
});

/**
 * An async server component pushing the ctx its layout handler handed it,
 * with `use` destructured off that ctx first. The bake seals the handle store
 * before it renders the tree, so the push is accepted into the segment the
 * ctx carries and collected under it (build-time collection never arms the
 * late-push guard: handle-store.ts notifyDrain arms `completed` only once a
 * stream consumer exists).
 */
async function LateLayoutPush({ ctx }: { ctx: any }) {
  const { use } = ctx;
  await new Promise((resolve) => setTimeout(resolve, 0));
  use(Crumbs)("late-crumb");
  return <span>late</span>;
}

const componentRouter: any = createRouter<Record<string, never>>({}).routes(
  ({ path, layout }: any) => [
    layout(<div>shell</div>, () => [
      layout(
        (ctx: any) => <LateLayoutPush ctx={ctx} />,
        () => [
          path(
            "/page",
            Prerender(() => <p>page</p>),
            { name: "page" },
          ),
        ],
      ),
    ]),
  ],
);

describe("matchForPrerender: a component the layout handler handed its ctx to", () => {
  it("files its push under the layout's segment, not the route's pin", async () => {
    const result = await componentRouter.matchForPrerender("/page", {});
    const handles = await deserializeResult<
      Record<string, Record<string, string[]>>
    >(result.handles);
    const ids: string[] = result.segments.map((s: any) => s.metadata.id);
    // The layout above the route: the deepest layout id, the route is its R0.
    const layout = ids.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(handles).toEqual({
      [layout]: { "test#Crumbs": ["late-crumb"] },
    });
  });
});
