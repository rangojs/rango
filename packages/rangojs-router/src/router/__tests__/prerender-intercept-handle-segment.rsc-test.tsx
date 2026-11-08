/**
 * A Prerender route's build gives each baked intercept its own ctx, as a live
 * render does (intercept-resolution.ts, withSegmentContext): the intercept
 * handlers run one after another, so a component one of them handed the ctx
 * to pushes after the build has moved on to the next intercept and its crumb
 * drops from the artifact that should hold it. The build used to pin the
 * shared build ctx per intercept and hand that one ctx to every handler and
 * layout, so each late push landed under the LAST baked intercept.
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
import { deserializeResult } from "../../cache/segment-codec.js";

const Crumbs = createHandle<string>(undefined, "test#Crumbs");

/** Pushes `label` after an await, through the ctx its handler was handed. */
async function LatePush({
  ctx,
  label,
}: {
  ctx: any;
  label: string;
}): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  ctx.use(Crumbs)(label);
  return <p>{label}</p>;
}

/** A router whose "/page" route carries the intercepts `slots` declares. */
function build(slots: (api: any) => any[]): any {
  return createRouter<Record<string, never>>({}).routes(
    ({ layout, intercept, path }: any) => [
      layout(<main>shell</main>, () => [
        path(
          "/page",
          Prerender(() => <p>page</p>),
          { name: "page" },
        ),
        ...slots({ intercept, layout }),
      ]),
    ],
  );
}

/** The baked intercept variant's segments and handle buckets. */
async function bakedHandles(router: any): Promise<{
  ids: string[];
  handles: Record<string, Record<string, string[]>>;
}> {
  const result = await router.matchForPrerender("/page", {});
  return {
    ids: result.interceptSegments.map((segment: any) => segment.metadata.id),
    handles: await deserializeResult(result.interceptHandles),
  };
}

describe("matchForPrerender: two baked intercepts on one route", () => {
  it("files each intercept handler's late push under its own segment", async () => {
    const router = build(({ intercept }: any) => [
      intercept("@a", ".page", (ctx: any) => <LatePush ctx={ctx} label="a" />),
      intercept("@b", ".page", (ctx: any) => <LatePush ctx={ctx} label="b" />),
    ]);
    const { ids, handles } = await bakedHandles(router);
    expect(ids).toEqual(["M0L0L0.@a", "M0L0L0.@b"]);
    expect(handles).toEqual({
      "M0L0L0.@a": { "test#Crumbs": ["a"] },
      "M0L0L0.@b": { "test#Crumbs": ["b"] },
    });
  });

  it("files an intercept handler's synchronous push under its own segment", async () => {
    // The shared pin used to carry the synchronous push; the ctx's own segment
    // carries it now.
    const router = build(({ intercept }: any) => [
      intercept("@a", ".page", (ctx: any) => {
        ctx.use(Crumbs)("a");
        return <p>a</p>;
      }),
      intercept("@b", ".page", (ctx: any) => {
        ctx.use(Crumbs)("b");
        return <p>b</p>;
      }),
    ]);
    const { handles } = await bakedHandles(router);
    expect(handles).toEqual({
      "M0L0L0.@a": { "test#Crumbs": ["a"] },
      "M0L0L0.@b": { "test#Crumbs": ["b"] },
    });
  });

  it("files an intercept layout's late push under its intercept's segment", async () => {
    const router = build(({ intercept, layout }: any) => [
      intercept(
        "@a",
        ".page",
        () => <p>a</p>,
        () => [layout((ctx: any) => <LatePush ctx={ctx} label="a-layout" />)],
      ),
      intercept("@b", ".page", () => <p>b</p>),
    ]);
    const { handles } = await bakedHandles(router);
    expect(handles).toEqual({
      "M0L0L0.@a": { "test#Crumbs": ["a-layout"] },
    });
  });
});
