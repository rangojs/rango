/**
 * Which segment owns a handle push made inside an intercept slot, through
 * serveShellRequest's partial navigation (the request the browser sends when
 * a link opens the modal).
 *
 * resolveInterceptEntry (router/intercept-resolution.ts) never pins
 * `_currentSegmentId` to the slot's id, as the parallel-slot funnels do
 * (segment-resolution/fresh.ts, revalidation.ts) and the build-time intercept
 * bake does (router/prerender-match.ts). A handler's `ctx.use(Handle)` and the
 * push of a loader (`loaderOwner`, segment-resolution/prefetch-deferral.ts)
 * read whatever segment was pinned last:
 *   - a layout the navigation re-ran: the push lands in the LAYOUT's bucket,
 *     so it follows the layout's run instead of the modal's;
 *   - nothing (the client holds every main segment, the usual navigation):
 *     a handler push throws "used outside of handler context" (the slot
 *     renders the error boundary, 500), a loader push is dropped.
 *
 * KNOWN GAP: every test here is vitest's `it.fails`, which keeps the suite
 * green while the assertion fails and turns red the moment it passes. Drop
 * `red` for `it` when resolveInterceptEntry pins the slot's id.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { withoutPushedBy } from "../../handles/pushed-by.js";

const red = it.fails;

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const ModalLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("modal-loader");
  return { title: "modal-data" };
});

const errors: string[] = [];

function makeRouter(push: "loader" | "handler") {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, intercept, loader }) => [
      layout(
        (ctx) => {
          ctx.use(Crumbs)("layout");
          return <main>shell</main>;
        },
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept(
            "@modal",
            ".item",
            (ctx) => {
              if (push === "handler") ctx.use(Crumbs)("modal-handler");
              return <dialog>modal</dialog>;
            },
            () => (push === "loader" ? [loader(ModalLoader)] : []),
          ),
        ],
      ),
    ]),
  );
}

async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

/** The pushes a response delivers, by the segment id that owns them. */
async function bucketsOf(
  result: Awaited<ReturnType<typeof serveShellRequest>>,
): Promise<Record<string, string[]>> {
  const handles = withoutPushedBy((await result.readHandles())!.hydration);
  return Object.fromEntries(
    Object.values(handles).flatMap((bySegment) =>
      Object.entries(bySegment).map(
        ([segmentId, values]) => [segmentId, values as string[]] as const,
      ),
    ),
  );
}

async function open(push: "loader" | "handler", held: "none" | "page") {
  const router = makeRouter(push);
  const cacheStore = new MemorySegmentCacheStore();
  let segments: string[] = [];
  if (held === "page") {
    segments = await matchedOf(
      (await serveShellRequest(router, "/list", { cacheStore, partial: true }))
        .flight,
    );
  }
  errors.length = 0;
  const result = await serveShellRequest(router, "/item/1", {
    cacheStore,
    partial: { from: "/list", segments },
  });
  return { result, segments, buckets: await bucketsOf(result) };
}

beforeEach(async () => {
  errors.length = 0;
  await resetShellTestState();
});

describe("control: a parallel slot's push is filed under the slot's own id", () => {
  it("the shape the intercept slot's bucket is expected to have", async () => {
    const router = createRouter({}).routes(
      urls(({ path, layout, parallel }) => [
        layout(
          (ctx) => {
            ctx.use(Crumbs)("layout");
            return <main>shell</main>;
          },
          () => [
            parallel({
              "@aside": (ctx) => {
                ctx.use(Crumbs)("aside");
                return <aside>aside</aside>;
              },
            }),
            path("/list", () => <ul>list</ul>, { name: "list" }),
          ],
        ),
      ]),
    );
    const result = await serveShellRequest(router, "/list", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: true,
    });
    expect(await bucketsOf(result)).toEqual({
      M0L0L0: ["layout"],
      "M0L0L0.@aside": ["aside"],
    });
  });
});

describe("a push made inside an intercept slot belongs to the slot", () => {
  for (const push of ["loader", "handler"] as const) {
    describe(`from the intercept's ${push}`, () => {
      red(
        "the client holds every main segment: the push is delivered under the slot's id",
        async () => {
          const { buckets } = await open(push, "page");
          expect(errors).toEqual([]);
          expect(buckets).toEqual({ "M0L0L0.@modal": [`modal-${push}`] });
        },
      );

      red(
        "the navigation re-ran the layout: the push is not filed under the layout",
        async () => {
          const { buckets } = await open(push, "none");
          expect(errors).toEqual([]);
          expect(buckets).toEqual({
            M0L0L0: ["layout"],
            "M0L0L0.@modal": [`modal-${push}`],
          });
        },
      );
    });
  }
});
