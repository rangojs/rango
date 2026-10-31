/**
 * A route's loaders are inherited into a child layout that has parallel
 * slots (resolveOrphanLayout and the loader-only pass,
 * router/segment-resolution/revalidation.ts), so a slot's useLoader() reaches
 * them through a route `loading()` boundary. buildMatchResult
 * (router/match-result.ts) drops that copy when the route's own loader
 * segment is in the same payload and no fallback hides it.
 *
 * Which copies a payload carries must agree on every request of a route: a
 * layout that holds a loader entry on one render and none on the next gains
 * or loses its StreamedLoaderErrorBoundary (segment-system.tsx), so React
 * remounts it and its Outlet (docs/tree-structure.md). The decision is made
 * from the route entry, the same on the document and on partials
 * (inheritedCopyRedundant):
 *
 * - no `loading()`, or `loading(false)`: the copy is dropped everywhere. The
 *   walkers emit `loading(false)` as `loading: null`, which used to read as a
 *   declared fallback and sent the copy on every request (rango-t156).
 * - `loading(fallback)`: the copy is kept everywhere, including a partial
 *   that carries the route's loader segments without the route segment.
 * - `loading(fallback, { ssr: false })`: a document renders no fallback (its
 *   route segment carries `loading: null`), and partials carry the fallback.
 *   The copy is kept everywhere, so the client's held document segments and
 *   a later answer give the layout the same loader entries.
 *
 * The server-only copy marker never reaches the payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";

const Data = createLoader(async () => ({ value: "route-data" }));

const TOUCH_ACTION = "src/inherited.actions.ts#touch";
async function touch(): Promise<void> {}

const errors: string[] = [];

/** The child layout every route below declares, with one parallel slot. */
const Inner = () => <section>inner</section>;
const Side = () => <aside>side</aside>;

const router = createRouter({
  id: "inherited-loader-copy",
  onError: ({ error }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
}).routes(
  urls(({ path, layout, loader, loading, parallel, revalidate }) => [
    layout(
      () => <main>shell</main>,
      () => [
        path("/", () => <p>home</p>, { name: "home" }),
        path(
          "/plain",
          () => <article>plain</article>,
          { name: "plain" },
          () => [
            loader(Data),
            layout(Inner, () => [parallel({ "@side": Side })]),
          ],
        ),
        path(
          "/off",
          () => <article>off</article>,
          { name: "off" },
          () => [
            loader(Data),
            loading(false),
            layout(Inner, () => [parallel({ "@side": Side })]),
          ],
        ),
        path(
          "/fallback",
          () => <article>fallback</article>,
          { name: "fallback" },
          () => [
            loader(Data),
            loading(<p>loading</p>),
            layout(Inner, () => [parallel({ "@side": Side })]),
          ],
        ),
        path(
          "/ssr-off",
          () => <article>ssr-off</article>,
          { name: "ssrOff" },
          () => [
            loader(Data),
            loading(<p>loading</p>, { ssr: false }),
            layout(Inner, () => [parallel({ "@side": Side })]),
          ],
        ),
        // The route's handler never re-runs, so a partial carries its loader
        // segments without the route segment that declares loading().
        path(
          "/held",
          () => <article>held</article>,
          { name: "held" },
          () => [
            loader(Data),
            loading(<p>loading</p>),
            revalidate(() => false),
            layout(Inner, () => [parallel({ "@side": Side })]),
          ],
        ),
      ],
    ),
  ]),
);

interface PayloadSegment {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface Payload {
  matched: string[];
  segments: PayloadSegment[];
}

async function read(result: ServeShellRequestResult): Promise<Payload> {
  const { metadata } = await deserializeResult<{ metadata: Payload }>(
    result.flight!,
  );
  return metadata;
}

/** The ids of `Data`'s segments a payload carries, in payload order. */
function dataSegments(payload: Payload): string[] {
  return payload.segments
    .filter((s) => s.type === "loader" && s.id.endsWith(`.${Data.$$id}`))
    .map((s) => s.id);
}

/** Every key the payload's segments carry, across all of them. */
function segmentKeys(payload: Payload): Set<string> {
  return new Set(payload.segments.flatMap((s) => Object.keys(s)));
}

async function documentOf(url: string): Promise<Payload> {
  return read(
    await serveShellRequest(router, url, {
      cacheStore: new MemorySegmentCacheStore(),
    }),
  );
}

/** The document of `url`, a navigation to it from `/`, and an action on it. */
async function everyRequestOf(url: string): Promise<{
  document: Payload;
  navigation: Payload;
  action: Payload;
}> {
  const home = await documentOf("/");
  const document = await documentOf(url);
  const navigation = await read(
    await serveShellRequest(router, url, {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/", segments: home.matched },
    }),
  );
  const action = await read(
    await serveShellRequest(router, url, {
      cacheStore: new MemorySegmentCacheStore(),
      action: { ref: touch, id: TOUCH_ACTION, segments: document.matched },
    }),
  );
  return { document, navigation, action };
}

beforeEach(async () => {
  errors.length = 0;
  await resetShellTestState();
});

describe("a route loader inherited into a layout with parallel slots", () => {
  it.each([
    ["no loading()", "/plain"],
    ["loading(false)", "/off"],
  ])(
    "%s: only the route's own copy, on the document, a navigation and an action",
    async (_label, url) => {
      const { document, navigation, action } = await everyRequestOf(url);
      expect(errors).toEqual([]);
      for (const payload of [document, navigation, action]) {
        expect(dataSegments(payload)).toHaveLength(1);
        expect(payload.matched).toEqual(
          expect.arrayContaining(dataSegments(payload)),
        );
      }
    },
  );

  it.each([
    ["loading(fallback)", "/fallback"],
    ["loading(fallback, { ssr: false })", "/ssr-off"],
  ])(
    "%s: the route's copy and the layout's, on the document, a navigation and an action",
    async (_label, url) => {
      const { document, navigation, action } = await everyRequestOf(url);
      expect(errors).toEqual([]);
      const ids = dataSegments(document);
      expect(ids).toHaveLength(2);
      expect(dataSegments(navigation)).toEqual(ids);
      expect(dataSegments(action)).toEqual(ids);
      for (const payload of [document, navigation, action]) {
        expect(payload.matched).toEqual(expect.arrayContaining(ids));
      }
    },
  );

  it("loading(fallback) with the route's handler held: an action that re-runs the loader keeps the layout's copy", async () => {
    // The action's payload carries the loader segments and no route segment.
    // Deciding from the route segment's loading dropped the copy here while
    // the document had sent it, so the layout lost its loader entry.
    const { document, action } = await everyRequestOf("/held");
    expect(errors).toEqual([]);
    const ids = dataSegments(document);
    expect(ids).toHaveLength(2);
    expect(action.segments.some((s) => s.type === "route")).toBe(false);
    expect(dataSegments(action)).toEqual(ids);
    expect(action.matched).toEqual(expect.arrayContaining(ids));
  });

  it.each(["/plain", "/off", "/fallback", "/ssr-off", "/held"])(
    "%s: no server-only copy marker reaches the payload",
    async (url) => {
      const { document, navigation, action } = await everyRequestOf(url);
      for (const payload of [document, navigation, action]) {
        const keys = segmentKeys(payload);
        expect(keys.has("_inherited")).toBe(false);
        expect(keys.has("_redundantCopy")).toBe(false);
      }
    },
  );
});
