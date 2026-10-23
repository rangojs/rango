/**
 * One handler output stored three ways reaches the client as the same
 * segments: a route cache() record (the segment cache, withCacheLookup's
 * HIT), a build-time Prerender artifact (the bundled prerender store) and an
 * on-demand overlay entry (router.prerender() into the router's `prerender`
 * store). cache-lookup.ts serves the three through two paths today
 * (yieldFromStore for the prerender sources, the record HIT for the cache);
 * serving them through one function must keep the three answers equal.
 *
 * Each source runs through serveShellRequest, the router's production
 * request handler, on its own router with the same tree; only the route's
 * storage differs. The page handler counts its runs, so each served response
 * is shown to come from the store, not from a render.
 *
 * An action re-renders live, past the segment cache, except on a Prerender
 * route that is not a passthrough: its handler is evicted at build, so the
 * re-render serves the stored entry (cache-lookup.ts, the gate in front of
 * tryPrerenderLookup). Both Prerender sources must keep answering it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { isValidElement } from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../../../testing/flight.entry.js";
import { textContent } from "../../../testing/flight-tree.js";
import { createMemoryPrerenderStore } from "../../../testing/index.js";
import {
  createLoader,
  createRouter,
  Meta,
  Prerender,
  urls,
  type BuildContext,
  type HandlerContext,
} from "../../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../../cache/index.js";
import { deserializeResult } from "../../../cache/segment-codec.js";

/** Page handler runs, across the test. */
let pageRuns = 0;

/** The page, as a live handler and as a Prerender handler. */
function page(
  ctx: Pick<HandlerContext<{ id: string }>, "params" | "use">,
): React.ReactNode {
  pageRuns += 1;
  ctx.use(Meta)({ title: `item ${ctx.params.id}` });
  return <h1>{`item ${ctx.params.id}`}</h1>;
}

const buildPage = (ctx: BuildContext<{ id: string }>): React.ReactNode =>
  page({ params: ctx.params, use: ctx.use as HandlerContext["use"] });

const StockLoader = createLoader(async () => ({ stock: 3 }));

type Source = "segment cache" | "prerender build" | "on-demand overlay";

/**
 * The same tree on every router: a layout around /item/:id with a loader.
 * Only how the route stores its handler output differs.
 */
function makeRouter(source: Source) {
  const handler =
    source === "segment cache"
      ? page
      : source === "prerender build"
        ? Prerender<{ id: string }>(async () => [{ id: "1" }], buildPage)
        : Prerender<{ id: string }>(async () => [], buildPage, {
            onDemand: true,
          });
  return createRouter({
    ...(source === "on-demand overlay"
      ? { prerender: { store: createMemoryPrerenderStore() } }
      : {}),
  }).routes(
    urls(({ layout, path, loader, cache }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/item/:id", handler, { name: "item" }, () => [
            loader(StockLoader),
            ...(source === "segment cache" ? [cache({ ttl: 300 })] : []),
          ]),
        ],
      ),
    ]),
  );
}

interface Served {
  segments: unknown[];
  handles: unknown;
  /** An action's answer, as the browser reads it. */
  answer?: unknown;
}

/**
 * The segments and handle data of a response, as the browser decodes them:
 * every field of every segment, a rendered element by its text and a
 * loader's data settled.
 */
async function served(result: ServeShellRequestResult): Promise<Served> {
  expect(result.response.status).toBe(200);
  const payload = await deserializeResult<{
    metadata: { segments: Array<Record<string, unknown>> };
  }>(result.flight!);
  const segments = await Promise.all(
    payload.metadata.segments.map(async (segment) => {
      const fields: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(segment)) {
        fields[field] =
          field === "component" || isValidElement(value)
            ? `text: ${textContent(value)}`
            : await value;
      }
      return fields;
    }),
  );
  const answer = await result.readAction();
  return {
    segments,
    handles: (await result.readHandles())?.hydration,
    ...(answer && { answer }),
  };
}

/** A JS server action called from the page. */
async function save(): Promise<string> {
  return "saved";
}

/** Stores the page in `source` the way production fills it, then serves it. */
async function serveFrom(
  source: Source,
  options: ServeShellRequestOptions = {},
): Promise<Served> {
  const router = makeRouter(source);
  const cacheStore = new MemorySegmentCacheStore();
  if (source === "segment cache") {
    // The first request of the same kind renders and writes the record (a
    // navigation's record is keyed apart from a document's).
    await serveShellRequest(router, "/item/1", { cacheStore, ...options });
  } else if (source === "prerender build" && options.action) {
    // The build artifact exists before the page calls the action.
    await serveShellRequest(router, "/item/1", { cacheStore });
  } else if (source === "on-demand overlay") {
    expect(await router.prerender({ env: {} })("/item/1")).toMatchObject({
      ok: true,
      status: "rendered",
    });
  }
  const runsBefore = pageRuns;
  const result = await serveShellRequest(router, "/item/1", {
    cacheStore,
    ...options,
  });
  if (source === "prerender build" && !options.action) {
    // The URL's first request bakes the build artifact (one handler run, as
    // `vite build` runs it) and is served from the prerender store.
    expect(pageRuns - runsBefore).toBe(1);
    const bakedRuns = pageRuns;
    const again = await serveShellRequest(router, "/item/1", {
      cacheStore,
      ...options,
    });
    expect(pageRuns).toBe(bakedRuns);
    return served(again);
  }
  expect(pageRuns).toBe(runsBefore);
  return served(result);
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("stored segments: the same entry from each source", () => {
  it.each([
    ["a document", {}],
    ["a navigation", { partial: { from: "/" } }],
  ] as const)(
    "%s gets the same segments and handles from each source",
    async (_label, options) => {
      const fromCache = await serveFrom("segment cache", options);
      const fromBuild = await serveFrom("prerender build", options);
      const fromOverlay = await serveFrom("on-demand overlay", options);

      // The stored layouts and route, then the loader run fresh.
      expect(fromCache.segments).toMatchObject([
        { type: "layout" },
        { type: "layout", component: "text: shell" },
        { type: "route", component: "text: item 1", params: { id: "1" } },
        { type: "loader", loaderData: { ok: true, data: { stock: 3 } } },
      ]);
      expect(JSON.stringify(fromCache.handles)).toContain('"title":"item 1"');
      expect(fromBuild).toEqual(fromCache);
      expect(fromOverlay).toEqual(fromCache);
    },
  );
});

describe("an action re-render of a Prerender route", () => {
  it.each(["prerender build", "on-demand overlay"] as const)(
    "%s: serves the stored entry, the handler does not run",
    async (source) => {
      const navigation = await serveFrom(source, { partial: { from: "/" } });
      // serveFrom fails when the page handler runs for the action.
      const { answer, ...action } = await serveFrom(source, {
        action: { ref: save, id: "src/item.actions.ts#save" },
      });
      expect(answer).toEqual({
        ok: true,
        result: "saved",
        revalidationError: null,
      });
      expect(action.segments).toMatchObject([
        { type: "layout" },
        { type: "layout", component: "text: shell" },
        { type: "route", component: "text: item 1", params: { id: "1" } },
        { type: "loader", loaderData: { ok: true, data: { stock: 3 } } },
      ]);
      expect(action).toEqual(navigation);
    },
  );
});
