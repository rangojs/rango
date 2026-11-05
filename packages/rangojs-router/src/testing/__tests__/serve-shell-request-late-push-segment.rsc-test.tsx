/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout's,
 * a parallel slot's and an intercept's ctx each carry their own segment
 * (withSegmentScope), and that segment holds however the component got hold of
 * the push: the ctx itself, a `use` destructured off it, or a spread copy of
 * the ctx. A route handler's ctx stays the request's one ctx, so it reads the
 * shared pin: the slot and the intercept put that pin back after their own
 * handler, which leaves the route's there.
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
  type ServeShellRequestOptions,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctx.use(Crumbs)(label);
  return <span>{label}</span>;
}

/** The same, through a `use` the handler destructured (or spread) off the ctx. */
async function LatePushDetached({
  push,
  label,
}: {
  push: HandlerContext["use"];
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  push(Crumbs)(label);
  return <span>{label}</span>;
}

/** A loader with a cache() config: its read installs the loader-cache interceptor. */
const Cached = createLoader(async () => ({ cached: true }));

function makeRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel, intercept, loader, cache }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(
            (ctx) => (
              <div>
                <LatePush ctx={ctx} label="layout" />
              </div>
            ),
            () => [
              path("/component-layout", () => <p>page</p>, {
                name: "componentLayout",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <LatePush ctx={ctx} label="slot" />,
              }),
              path("/component-slot", () => <p>page</p>, {
                name: "componentSlot",
              }),
            ],
          ),
          path("/component", (ctx) => <LatePush ctx={ctx} label="route" />, {
            name: "component",
          }),
          // A parallel slot below the route pins the shared segment id to its
          // own after the route handler returns.
          path(
            "/component-with-slot",
            (ctx) => <LatePush ctx={ctx} label="route-with-slot" />,
            { name: "componentWithSlot" },
            () => [parallel({ "@aside": () => <aside>aside</aside> })],
          ),
          layout(
            (ctx) => {
              const { use } = ctx;
              return <LatePushDetached push={use} label="layout-detached" />;
            },
            () => [
              path("/detached-layout", () => <p>page</p>, {
                name: "detachedLayout",
              }),
            ],
          ),
          layout(
            () => <section>detached slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => {
                  const { use } = ctx;
                  return <LatePushDetached push={use} label="slot-detached" />;
                },
              }),
              path("/detached-slot", () => <p>page</p>, {
                name: "detachedSlot",
              }),
            ],
          ),
          layout(
            (ctx) => {
              const copy = { ...ctx };
              return <LatePushDetached push={copy.use} label="layout-spread" />;
            },
            () => [
              path("/spread-layout", () => <p>page</p>, {
                name: "spreadLayout",
              }),
            ],
          ),
          // The layout's cached loader installs the loader-cache interceptor on
          // the handler ctx: the layout's `use` must reach setupLoaderAccess
          // through it with its own receiver.
          layout(
            (ctx) => <LatePush ctx={ctx} label="layout-cached" />,
            () => [
              path("/cached-layout", () => <p>page</p>, {
                name: "cachedLayout",
              }),
              loader(Cached, () => [cache({ ttl: 60 })]),
            ],
          ),
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/photo/:id", () => <figure>photo</figure>, { name: "photo" }),
          intercept("@modal", ".photo", (ctx) => (
            <LatePush ctx={ctx} label="intercept" />
          )),
        ],
      ),
    ]),
  );
}

/** The segment ids the response's tree matched. */
async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

async function serve(
  url: string,
  init?: Pick<ServeShellRequestOptions, "partial">,
) {
  errors.length = 0;
  const result = await serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(init ?? {}),
  });
  return { errors: [...errors], matched: await matchedOf(result.flight) };
}

/** The one LateHandlePushError the response reported, and its segment. */
function latePushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  const segment = /for segment "([^"]+)" was pushed after/.exec(reported[0]!);
  expect(segment).not.toBeNull();
  return segment![1]!;
}

/** The last layout segment the tree matched. */
function layoutOf(matched: string[]): string {
  return matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
}

/** The last route segment the tree matched. */
function routeOf(matched: string[]): string {
  return matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
}

/** The parallel slot segment whose id ends with `slot`. */
function slotOf(matched: string[], slot: string): string {
  return matched.find((id) => id.endsWith(`.${slot}`))!;
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a LateHandlePushError names the segment whose ctx pushed", () => {
  it("the layout's, for a component the layout handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-layout");
    expect(latePushSegment(reported)).toBe(layoutOf(matched));
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-slot");
    expect(latePushSegment(reported)).toBe(slotOf(matched, "@panel"));
  });

  it("the route's, for a component the route handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component");
    expect(latePushSegment(reported)).toBe(routeOf(matched));
  });

  it("the route's, for a component the route handler handed its ctx to, with a parallel slot below it", async () => {
    const { errors: reported, matched } = await serve("/component-with-slot");
    expect(slotOf(matched, "@aside")).toBeDefined();
    expect(latePushSegment(reported)).toBe(routeOf(matched));
  });

  it("the layout's, for a component the handler handed a destructured `use` to", async () => {
    const { errors: reported, matched } = await serve("/detached-layout");
    expect(latePushSegment(reported)).toBe(layoutOf(matched));
  });

  it("the slot's, for a component the handler handed a destructured `use` to", async () => {
    const { errors: reported, matched } = await serve("/detached-slot");
    expect(latePushSegment(reported)).toBe(slotOf(matched, "@panel"));
  });

  it("the layout's, for a component the handler handed a spread copy's `use` to", async () => {
    const { errors: reported, matched } = await serve("/spread-layout");
    expect(latePushSegment(reported)).toBe(layoutOf(matched));
  });

  it("the layout's, when its handler's ctx.use goes through the loader-cache interceptor", async () => {
    const { errors: reported, matched } = await serve("/cached-layout");
    expect(latePushSegment(reported)).toBe(layoutOf(matched));
  });

  it("the intercept slot's, for a component the intercept handler handed its ctx to", async () => {
    const list = await serve("/list");
    const { errors: reported, matched } = await serve("/photo/1", {
      partial: { from: "/list", segments: list.matched },
    });
    expect(latePushSegment(reported)).toBe(slotOf(matched, "@modal"));
  });
});
