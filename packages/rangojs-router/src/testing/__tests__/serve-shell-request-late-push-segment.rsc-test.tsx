/**
 * Which segment a late handle push names in the dev LateHandlePushError,
 * through serveShellRequest and the router's onError: the segment whose
 * handler handed its ctx to the component that pushed.
 *
 * The walker pins `_currentSegmentId` on the request's one handler ctx before
 * each segment's handler and moves it on as resolution continues, so a push a
 * component makes after its await read the pin of whatever ran last: an async
 * component handed a layout's ctx named the child route's segment, one handed
 * a slot's ctx named the next slot's. A layout's or slot's ctx carries its own
 * segment (withSegmentScope, router/handler-context.ts), and its `use` runs in
 * that segment's runAsSegment scope, so the push function it creates, and the
 * loader it starts, are bound to it, as is the segment a `"use cache"` call
 * given the ctx records under.
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
  type OnErrorContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { cachedCrumb } from "./fixtures/streamed-handle-owner-data.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Pushes with the loader ctx it is run for. */
const CrumbsLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("loader");
  return null;
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts a loader with the ctx it was handed, once the walk is over. */
async function LoaderPush({
  ctx,
}: {
  ctx: HandlerContext<any, any>;
}): Promise<React.ReactNode> {
  await wait(10);
  await ctx.use(CrumbsLoader);
  return <p>loader</p>;
}

/** Pushes through a "use cache" call given the ctx, once the walk is over. */
async function CachedPush({
  ctx,
}: {
  ctx: HandlerContext<any, any>;
}): Promise<React.ReactNode> {
  await wait(10);
  await cachedCrumb(ctx, "cached");
  return <p>cached</p>;
}

/** Pushes with the ctx it was handed once the walk is over. */
async function LatePush({
  ctx,
  label,
}: {
  ctx: HandlerContext<any, any>;
  label: string;
}): Promise<React.ReactNode> {
  await wait(10);
  ctx.use(Crumbs)(label);
  return <p>{label}</p>;
}

/** The segment each reported message names. */
function pushedSegments(messages: string[]): string[] {
  return messages.map((message) => {
    const match = /for segment "([^"]+)" was pushed after/.exec(message);
    return match ? match[1] : message;
  });
}

/** Serve `/p` of `routes` and return the messages onError reported. */
async function serve(
  routes: ReturnType<typeof urls>,
  messages: string[],
): Promise<void> {
  const router = createRouter({
    onError: (ctx: OnErrorContext) => {
      messages.push(ctx.error.message);
    },
  }).routes(routes);
  await serveShellRequest(router, "/p", {
    cacheStore: new MemorySegmentCacheStore(),
  });
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a late push through the ctx a handler handed out", () => {
  it("names the layout's segment, not the child route's", async () => {
    const messages: string[] = [];
    await serve(
      urls(({ path, layout }) => [
        layout(
          (ctx) => (
            <main>
              <LatePush ctx={ctx} label="layout" />
            </main>
          ),
          () => [path("/p", () => <p>page</p>, { name: "p" })],
        ),
      ]),
      messages,
    );
    expect(pushedSegments(messages)).toEqual(["M0L0L0"]);
  });

  it("names the slot's segment, not a later slot's", async () => {
    const messages: string[] = [];
    await serve(
      urls(({ path, layout, parallel }) => [
        layout(
          () => <main>shell</main>,
          () => [
            path(
              "/p",
              () => <p>page</p>,
              { name: "p" },
              () => [
                parallel({
                  "@a": (ctx) => <LatePush ctx={ctx} label="a" />,
                  "@b": () => <aside>b</aside>,
                }),
              ],
            ),
          ],
        ),
      ]),
      messages,
    );
    expect(pushedSegments(messages)).toEqual(["M0L0L0R0.@a"]);
  });

  it("names the layout's segment for a loader it starts", async () => {
    const messages: string[] = [];
    await serve(
      urls(({ path, layout }) => [
        layout(
          (ctx) => (
            <main>
              <LoaderPush ctx={ctx} />
            </main>
          ),
          () => [path("/p", () => <p>page</p>, { name: "p" })],
        ),
      ]),
      messages,
    );
    expect(pushedSegments(messages)).toEqual(["M0L0L0"]);
  });

  it('names the layout\'s segment for a "use cache" call given its ctx', async () => {
    const messages: string[] = [];
    await serve(
      urls(({ path, layout }) => [
        layout(
          (ctx) => (
            <main>
              <CachedPush ctx={ctx} />
            </main>
          ),
          () => [path("/p", () => <p>page</p>, { name: "p" })],
        ),
      ]),
      messages,
    );
    expect(pushedSegments(messages)).toEqual(["M0L0L0"]);
  });

  it("control: a route handler's ctx names the route's segment", async () => {
    const messages: string[] = [];
    await serve(
      urls(({ path, layout }) => [
        layout(
          () => <main>shell</main>,
          () => [
            path("/p", (ctx) => <LatePush ctx={ctx} label="route" />, {
              name: "p",
            }),
          ],
        ),
      ]),
      messages,
    );
    expect(pushedSegments(messages)).toEqual(["M0L0L0R0"]);
  });
});
