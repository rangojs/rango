/**
 * Userland: a fetchable loader read (`?_rsc_loader=<id>`, what `load()` and a
 * `useRefreshLoaders()` refresh send) carries the handle values the loader's
 * body pushed, as a render does. serveShellRequest serves through the
 * router's real handler; readLoader() reads the reply as use-loader.tsx does.
 *
 * The read renders no segment: a push used to throw "used outside of handler
 * context", so a loader that writes its page's title failed every refresh
 * with a 500 and its data never arrived either. The browser files the values
 * under the segment that registers the loader (fetched-loader-handles.test.ts).
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
  Breadcrumbs,
  createLoader,
  createRouter,
  Meta,
  urls,
  type LoaderContext,
} from "../../index.rsc.js";
import type { MiddlewareFn } from "../../router/middleware.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

let renames = 0;
// From its third run on, the chat is untitled: the loader pushes nothing.
const ChatTitle = createLoader(async (ctx) => {
  renames += 1;
  if (renames > 2) return { name: null };
  ctx.use(Meta)({ title: `Chat ${renames}` });
  ctx.use(Breadcrumbs)({ label: `Chat ${renames}`, href: "/chat" });
  return { name: `Chat ${renames}` };
}, true);

const Members = createLoader(async (ctx) => {
  ctx.use(Breadcrumbs)({ label: "Members", href: "/chat/members" });
  return { count: 2 };
});

// Reads another loader, pushes a pending value and fills a deferred slot.
const ChatDetail = createLoader(async (ctx) => {
  const members = await ctx.use(Members);
  ctx.use(Meta)(Promise.resolve({ title: `Chat (${members.count})` }));
  // Settles nullish, as a `.defer()` slot that times out without `else`.
  ctx.use(Meta)(Promise.resolve(null) as unknown as Promise<{ title: string }>);
  const fill = ctx.use(Breadcrumbs).defer();
  queueMicrotask(() => fill({ label: "Detail", href: "/chat/detail" }));
  return { members: members.count };
}, true);

const seen: string[] = [];
const recordRead: MiddlewareFn = async (_ctx, next) => {
  seen.push("middleware");
  return next();
};
const GuardedTitle = createLoader(
  async (ctx) => {
    ctx.use(Meta)({ title: "Guarded" });
    return "ok";
  },
  { middleware: [recordRead] },
);

// A "use cache" function handed the loader's ctx: a HIT replays its push.
let cachedRuns = 0;
async function cachedChatTitle(ctx: LoaderContext): Promise<string> {
  "use cache";
  cachedRuns += 1;
  ctx.use(Meta)({ title: `Cached ${cachedRuns}` });
  return `Cached ${cachedRuns}`;
}
const CachedTitle = createLoader(async (ctx) => {
  return { title: await cachedChatTitle(ctx) };
}, true);

const router = createRouter({}).routes(
  urls(({ path, layout, loader }) => [
    layout(
      () => <div>layout</div>,
      () => [
        path(
          "/chat",
          () => <p>chat</p>,
          { name: "chat" },
          () => [loader(ChatTitle), loader(ChatDetail), loader(GuardedTitle)],
        ),
        path(
          "/cached",
          () => <p>cached</p>,
          { name: "cached" },
          () => [loader(CachedTitle)],
        ),
      ],
    ),
  ]),
);

const read = async (
  loader: { $$id: string },
  page = "/chat",
  cacheStore?: MemorySegmentCacheStore,
) => {
  const result = await serveShellRequest(
    router,
    `${page}?_rsc_loader=${encodeURIComponent(loader.$$id)}`,
    { headers: { accept: "text/x-component" }, cacheStore },
  );
  return { status: result.response.status, answer: await result.readLoader() };
};

beforeEach(async () => {
  renames = 0;
  cachedRuns = 0;
  seen.length = 0;
  await resetShellTestState();
});

describe("a fetchable loader read carries its handle pushes", () => {
  it("answers with the loader's value and what its body pushed", async () => {
    expect(await read(ChatTitle)).toEqual({
      status: 200,
      answer: {
        result: { name: "Chat 1" },
        error: null,
        handles: {
          [Meta.$$id]: [{ title: "Chat 1" }],
          [Breadcrumbs.$$id]: [{ label: "Chat 1", href: "/chat" }],
        },
      },
    });
    // Each read is its own run.
    expect((await read(ChatTitle)).answer?.handles[Meta.$$id]).toEqual([
      { title: "Chat 2" },
    ]);
    // A run that pushes nothing answers with no values: the browser clears
    // the loader's earlier ones.
    expect((await read(ChatTitle)).answer).toEqual({
      result: { name: null },
      error: null,
      handles: {},
    });
  });

  it("carries the pushes of a loader it reads, and pending ones once settled", async () => {
    const { status, answer } = await read(ChatDetail);
    expect(status).toBe(200);
    expect(answer).toEqual({
      result: { members: 2 },
      error: null,
      handles: {
        // The nullish pending push is dropped, as the browser drops it.
        [Meta.$$id]: [{ title: "Chat (2)" }],
        [Breadcrumbs.$$id]: [
          { label: "Members", href: "/chat/members" },
          { label: "Detail", href: "/chat/detail" },
        ],
      },
    });
  });

  it("pushes through a loader's own middleware", async () => {
    expect(await read(GuardedTitle)).toEqual({
      status: 200,
      answer: {
        result: "ok",
        error: null,
        handles: { [Meta.$$id]: [{ title: "Guarded" }] },
      },
    });
    expect(seen).toEqual(["middleware"]);
  });

  it('replays a "use cache" push on a HIT, whoever stored the entry', async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, "/cached", { cacheStore });
    const stored = (await page.readHandles())!.hydration[Meta.$$id];
    expect(Object.values(stored)).toEqual([[{ title: "Cached 1" }]]);
    // The render stored the entry; the read is its HIT.
    expect(await read(CachedTitle, "/cached", cacheStore)).toEqual({
      status: 200,
      answer: {
        result: { title: "Cached 1" },
        error: null,
        handles: { [Meta.$$id]: [{ title: "Cached 1" }] },
      },
    });
    expect(cachedRuns).toBe(1);
  });

  it("a render of the page still files the pushes under the route", async () => {
    const page = await serveShellRequest(router, "/chat");
    const handles = await page.readHandles();
    const routeId = Object.keys(handles!.hydration[Meta.$$id]).at(-1)!;
    expect(handles!.hydration[Meta.$$id][routeId]).toContainEqual({
      title: "Chat 1",
    });
  });
});
