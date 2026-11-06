/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout
 * handler's ctx carries its own segment, so the message names the layout; a
 * route handler's ctx reads the request's pin, which is still the route's.
 *
 * A push that lands before collection completes shows the same attribution as
 * data: it files under the segment whose ctx made it, so the layout's
 * collectHandle(Handle) reads what its own component pushed.
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
import {
  createHandle,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { HandleData } from "../../server/handle-store.js";

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

/** The same, taking `use` off the ctx: no receiver is left to read it off. */
async function LatePushDetached({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  const { use } = ctx;
  await new Promise((resolve) => setTimeout(resolve, 0));
  use(Crumbs)(label);
  return <span>{label}</span>;
}

/** Pushes with no await: before handle collection completes. */
function SyncPush({ ctx, label }: { ctx: HandlerContext; label: string }) {
  ctx.use(Crumbs)(label);
  return <span>{label}</span>;
}

function makeRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel }) => [
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
          layout(
            (ctx) => (
              <div>
                <LatePushDetached ctx={ctx} label="layout-detached" />
              </div>
            ),
            () => [
              path("/component-detached", () => <p>page</p>, {
                name: "componentDetached",
              }),
            ],
          ),
          layout(
            (ctx) => (
              <div>
                <SyncPush ctx={ctx} label="layout-sync" />
              </div>
            ),
            () => [
              path("/component-sync", () => <p>page</p>, {
                name: "componentSync",
              }),
            ],
          ),
          layout(
            () => <section>sync slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <SyncPush ctx={ctx} label="slot-sync" />,
              }),
              path("/component-sync-slot", () => <p>page</p>, {
                name: "componentSyncSlot",
              }),
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
  return {
    errors: [...errors],
    matched: await matchedOf(result.flight),
    crumbs: await crumbsBySegment(result),
  };
}

/** Each segment's Crumbs values the response delivers. */
async function crumbsBySegment(
  result: ServeShellRequestResult,
): Promise<Record<string, unknown[]>> {
  const handles = await result.readHandles();
  const data = (handles?.late.at(-1) ?? handles?.hydration ?? {}) as HandleData;
  return (data[Crumbs.$$id] ?? {}) as Record<string, unknown[]>;
}

/** The one LateHandlePushError the response reported, and its segment. */
function latePushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  const segment = /for segment "([^"]+)" was pushed after/.exec(reported[0]!);
  expect(segment).not.toBeNull();
  return segment![1]!;
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a LateHandlePushError names the segment whose ctx pushed", () => {
  it("the layout's, for a component the layout handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-layout");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  // Control: the route's ctx carries nothing, so this reads the walker's pin,
  // which is still the route's here because the route declares no parallel
  // slot. One that does pins the slot after the handler and is named instead
  // (execution-model.md, "A streamed handler keeps its segment").
  it("the route's, for a component the route handler handed its ctx to, when the route declares no slot", async () => {
    const { errors: reported, matched } = await serve("/component");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a component that took use off the layout's ctx", async () => {
    const { errors: reported, matched } = await serve("/component-detached");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });
});

describe("a push a component makes before collection completes files under the ctx's segment", () => {
  it("the layout's, for a component the layout handler handed its ctx to", async () => {
    const { crumbs, matched } = await serve("/component-sync");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(crumbs[layout]).toEqual(["layout-sync"]);
    // The route the walker pinned by the time the component rendered keeps
    // its own bucket empty.
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(crumbs[route]).toBeUndefined();
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { crumbs, matched } = await serve("/component-sync-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(crumbs[slot]).toEqual(["slot-sync"]);
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(crumbs[route]).toBeUndefined();
  });
});
