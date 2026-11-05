/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout's
 * or a slot's ctx carries its own segment and binds `ctx.use` to it, so the
 * message names the layout or the slot however the push reaches `use`: as a
 * method, detached (`const { use } = ctx`), through a `{ ...ctx }` copy, or as
 * a loader the component starts. A route handler's ctx reads the request's
 * pin, which is still the route's.
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
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];

const timer = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await timer();
  ctx.use(Crumbs)(label);
  return <span>{label}</span>;
}

/** A `use` taken off the ctx it came from, called after an `await`. */
async function DetachedValuePush({
  use,
  label,
}: {
  use: (handle: typeof Crumbs) => (value: string) => void;
  label: string;
}) {
  await timer();
  use(Crumbs)(label);
  return <span>{label}</span>;
}

/** A loader a component the layout handed its ctx to starts. */
const StartedLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("loader");
  return null;
});

async function StartLoader({ ctx }: { ctx: HandlerContext }) {
  await timer();
  await ctx.use(StartedLoader);
  return <span>started</span>;
}

/** A cached loader: its binding installs ctx.use's interceptor on the ctx. */
const CachedLoader = createLoader(async () => "cached");

function makeRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel, loader, cache }) => [
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
          // `use` destructured off the ctx: a detached call.
          layout(
            (ctx) => (
              <div>
                <DetachedValuePush
                  use={(({ use }) => use)(ctx)}
                  label="detached"
                />
              </div>
            ),
            () => [
              path("/detached-layout", () => <p>page</p>, {
                name: "detachedLayout",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@detached": (ctx) => (
                  <DetachedValuePush
                    use={(({ use }) => use)(ctx)}
                    label="slot-detached"
                  />
                ),
              }),
              path("/detached-slot", () => <p>page</p>, {
                name: "detachedSlot",
              }),
            ],
          ),
          // A copy owns the bound `use`, so a push through it is still the
          // layout's.
          layout(
            (ctx) => {
              const copy = { ...ctx };
              return (
                <div>
                  <DetachedValuePush use={copy.use} label="copy" />
                </div>
              );
            },
            () => [
              path("/copy-layout", () => <p>page</p>, { name: "copyLayout" }),
            ],
          ),
          // A loader started through the handed ctx belongs to the layout.
          layout(
            (ctx) => (
              <div>
                <StartLoader ctx={ctx} />
              </div>
            ),
            () => [
              path("/started-loader", () => <p>page</p>, {
                name: "startedLoader",
              }),
            ],
          ),
          // The same, while a cached loader's binding has replaced the
          // request ctx's `use` with its interceptor.
          layout(
            (ctx) => (
              <div>
                <LatePush ctx={ctx} label="intercepted" />
              </div>
            ),
            () => [
              path(
                "/intercepted-layout",
                () => <p>page</p>,
                { name: "interceptedLayout" },
                () => [loader(CachedLoader, () => [cache({ ttl: 300 })])],
              ),
            ],
          ),
          // An orphan layout: its own segment, no route of its own.
          path(
            "/component-orphan",
            () => <p>page</p>,
            { name: "componentOrphan" },
            () => [
              layout((ctx) => (
                <div>
                  <LatePush ctx={ctx} label="orphan" />
                </div>
              )),
            ],
          ),
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

async function serve(url: string) {
  errors.length = 0;
  const result = await serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
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

/** The last segment in `matched` whose id ends in the given shape. */
function segmentIn(matched: string[], ending: RegExp): string {
  const id = matched.filter((segment) => ending.test(segment)).at(-1);
  expect(id).toBeDefined();
  return id!;
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a LateHandlePushError names the segment whose ctx pushed", () => {
  it("the layout's, for a component the layout handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-layout");
    expect(latePushSegment(reported)).toBe(segmentIn(matched, /L\d+$/));
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-slot");
    expect(latePushSegment(reported)).toBe(segmentIn(matched, /\.@panel$/));
  });

  it("the route's, for a component the route handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component");
    expect(latePushSegment(reported)).toBe(segmentIn(matched, /R\d+$/));
  });

  it("the layout's, for a `use` destructured off the layout's ctx", async () => {
    const { errors: reported, matched } = await serve("/detached-layout");
    expect(latePushSegment(reported)).toBe(segmentIn(matched, /L\d+$/));
  });

  it("the slot's, for a `use` destructured off the slot's ctx", async () => {
    const { errors: reported, matched } = await serve("/detached-slot");
    expect(latePushSegment(reported)).toBe(segmentIn(matched, /\.@detached$/));
  });

  it("the layout's, through a `{ ...ctx }` copy the layout handed on", async () => {
    const { errors: reported, matched } = await serve("/copy-layout");
    expect(latePushSegment(reported)).toBe(segmentIn(matched, /L\d+$/));
  });

  it("the layout's, for a loader a component the layout handed its ctx to starts", async () => {
    const { errors: reported, matched } = await serve("/started-loader");
    expect(latePushSegment(reported)).toBe(segmentIn(matched, /L\d+$/));
  });

  it("the layout's, while a cached loader's binding has replaced the ctx's `use`", async () => {
    const { errors: reported, matched } = await serve("/intercepted-layout");
    expect(latePushSegment(reported)).toBe(segmentIn(matched, /L\d+$/));
  });

  it("the orphan layout's, for a component the orphan's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-orphan");
    expect(latePushSegment(reported)).toBe(segmentIn(matched, /L\d+$/));
  });
});
