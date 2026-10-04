/**
 * A route-level cache() stores and replays only its own subtree. Segments of
 * the entries above the boundary are live: they are not written to the cache
 * entry and resolve fresh on a HIT, document and partial alike (issue #906).
 * Before, cacheRoute stored every non-loader segment of the match and a HIT
 * yielded all of them, so a layout above the boundary ran 0 times on a HIT:
 * its header write was absent and its output was the MISS render's.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// JSON stand-in for the Flight codec (plugin-rsc is a virtual module).
function pluginRscMock() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    renderToReadableStream: (value: unknown) => {
      const bytes = encoder.encode(JSON.stringify(value) ?? "null");
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let result = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      return JSON.parse(result + decoder.decode());
    },
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { createElement } from "react";
import { createRouter } from "../../../router.js";
import { createLoader } from "../../../loader.rsc.js";
import { createVar } from "../../../context-var.js";
import { buildRouterTrieFromUrlpatterns } from "../../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import type { CachedEntryData } from "../../../cache/types.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";

const Visitor = createVar<string>({ cache: false });

const calls = { shell: 0, page: 0, inner: 0, orphanShell: 0, pprShell: 0 };
const loaderSaw: Array<string | undefined> = [];

const VisitorLoader = (createLoader as Function)(
  async (ctx: any) => {
    loaderSaw.push(ctx.get(Visitor));
    return { ok: true };
  },
  undefined,
  "test#CacheOuterVisitorLoader",
);

let router: any;
let store: MemorySegmentCacheStore;
const writes = new Map<string, string[]>();
let legacyOuterId: string | undefined;

function text(n: number, label: string) {
  return createElement("div", null, `${label}-${n}`);
}

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  const set = store.set.bind(store);
  store.set = async (
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ) => {
    writes.set(
      key,
      data.segments.map((s) => s.metadata.id),
    );
    return set(key, data, ttl, swr);
  };
  // Serve records as a whole-chain writer stored them: with a segment for the
  // layout above the boundary prepended.
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    const hit: any = await get(key);
    if (!hit?.data || legacyOuterId === undefined) return hit;
    const [first] = hit.data.segments;
    const outer = {
      ...first,
      encoded: JSON.stringify({ props: { children: "stale-shell" } }),
      metadata: { ...first.metadata, id: legacyOuterId, type: "layout" },
    };
    return {
      ...hit,
      data: { ...hit.data, segments: [outer, ...hit.data.segments] },
    };
  };
  router = createRouter({} as any);
  router.routes(({ path, cache, layout, loader }: any) => [
    layout(
      (ctx: any) => {
        calls.shell++;
        ctx.headers.set("x-shell", String(calls.shell));
        ctx.set(Visitor, `visitor-${calls.shell}`);
        return text(calls.shell, "shell");
      },
      () => [
        path("/outside", () => text(0, "outside"), { name: "outerOutside" }),
        cache({ ttl: 60, store }, () => [
          path(
            "/p/a",
            () => text(++calls.page, "a"),
            { name: "outerA" },
            () => [loader(VisitorLoader)],
          ),
          path("/p/b", () => text(++calls.page, "b"), { name: "outerB" }),
          layout(
            () => text(++calls.inner, "inner"),
            () => [
              cache({ ttl: 60, store }, () => [
                path("/p/nested", () => text(++calls.page, "nested"), {
                  name: "outerNested",
                }),
              ]),
            ],
          ),
        ]),
      ],
    ),
    layout(
      () => text(++calls.orphanShell, "orphan-shell"),
      () => [
        cache({ ttl: 60, store }),
        path("/o", () => text(++calls.page, "o"), { name: "outerOrphan" }),
      ],
    ),
    layout(
      () => text(++calls.pprShell, "ppr-shell"),
      () => [
        cache({ ttl: 60, store }, () => [
          path("/ppr", () => text(++calls.page, "ppr"), {
            name: "outerPpr",
            ppr: true,
          }),
        ]),
      ],
    ),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(async () => {
  await store.clear();
  writes.clear();
  loaderSaw.length = 0;
});

type Served = {
  header: string | null;
  segments: Array<{ id: string; type: string; text: unknown }>;
};

async function serve(
  pathname: string,
  partial?: { from: string; clientSegments: string[] },
): Promise<Served> {
  const request = partial
    ? new Request(
        `https://example.com${pathname}?_rsc_partial&_rsc_segments=${partial.clientSegments.join(",")}`,
        {
          headers: {
            accept: "text/x-component",
            "X-RSC-Router-Client-Path": `https://example.com${partial.from}`,
          },
        },
      )
    : new Request(`https://example.com${pathname}`, {
        headers: { accept: "text/html" },
      });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  let segments: any[] = [];
  let header: string | null = null;
  await runWithRequestContext(reqCtx, async () => {
    const result = partial
      ? await router.matchPartial(request, { env: {} })
      : await router.match(request, { env: {} });
    segments = result.segments;
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
    header = reqCtx.res.headers.get("x-shell");
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status: 200 }));
    }
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  return {
    header,
    segments: segments
      .filter((s) => s.type !== "loader")
      .map((s) => ({
        id: s.id,
        type: s.type,
        text: s.component?.props?.children ?? null,
      })),
  };
}

function textOf(served: Served, prefix: string): unknown {
  return served.segments.find(
    (s) => typeof s.text === "string" && s.text.startsWith(prefix),
  )?.text;
}

describe("route cache(): segments above the boundary stay live", () => {
  it("a document HIT re-runs the layout above the boundary and serves only the subtree from cache", async () => {
    const miss = await serve("/p/a");
    const shellAfterMiss = calls.shell;
    const pageAfterMiss = calls.page;
    const hit = await serve("/p/a");

    // Layout above the boundary: ran again, fresh output, its header is set.
    expect(calls.shell).toBe(shellAfterMiss + 1);
    expect(textOf(hit, "shell-")).toBe(`shell-${calls.shell}`);
    expect(hit.header).toBe(String(calls.shell));
    // Route inside the boundary: served from cache, handler skipped.
    expect(calls.page).toBe(pageAfterMiss);
    expect(textOf(hit, "a-")).toBe(textOf(miss, "a-"));
    // Same tree shape as the MISS, no duplicated segment.
    expect(hit.segments.map((s) => s.id)).toEqual(
      miss.segments.map((s) => s.id),
    );
  });

  it("stores only the boundary's subtree", async () => {
    const miss = await serve("/p/a");
    const [key, stored] = [...writes.entries()][0]!;
    expect(key.startsWith("doc:")).toBe(true);
    const shellId = miss.segments.find(
      (s) => typeof s.text === "string" && s.text.startsWith("shell-"),
    )!.id;
    const routeId = miss.segments.find((s) => s.type === "route")!.id;
    expect(stored).not.toContain(shellId);
    expect(stored).toContain(routeId);
    // Every stored id sits under the cache() entry, which is the route's parent.
    const boundaryId = miss.segments[miss.segments.length - 2]!.id;
    expect(stored.every((id) => id.startsWith(boundaryId))).toBe(true);
  });

  it("a loader inside the boundary reads what the live layout set on a HIT", async () => {
    await serve("/p/a");
    await serve("/p/a");
    expect(loaderSaw).toEqual([
      `visitor-${calls.shell - 1}`,
      `visitor-${calls.shell}`,
    ]);
  });

  it("a partial HIT renders the layout above the boundary fresh when the client lacks it", async () => {
    const outside = await serve("/outside");
    // The client comes from /outside: it has the root and the shell only.
    const clientSegments = outside.segments
      .filter((s) => s.type === "layout")
      .map((s) => s.id);
    const shellId = outside.segments.find(
      (s) => typeof s.text === "string" && s.text.startsWith("shell-"),
    )!.id;
    const withoutShell = clientSegments.filter((id) => id !== shellId);

    await serve("/p/b", { from: "/outside", clientSegments: withoutShell });
    const pageAfterMiss = calls.page;
    const shellBefore = calls.shell;
    const hit = await serve("/p/b", {
      from: "/outside",
      clientSegments: withoutShell,
    });

    expect(calls.shell).toBe(shellBefore + 1);
    expect(textOf(hit, "shell-")).toBe(`shell-${calls.shell}`);
    expect(hit.header).toBe(String(calls.shell));
    expect(calls.page).toBe(pageAfterMiss);
  });

  it("a record holding a segment above the boundary replays only the subtree", async () => {
    const outside = await serve("/outside");
    const shellId = outside.segments.find(
      (s) => typeof s.text === "string" && s.text.startsWith("shell-"),
    )!.id;
    const clientSegments = outside.segments
      .filter((s) => s.type === "layout" && s.id !== shellId)
      .map((s) => s.id);

    await serve("/p/b", { from: "/outside", clientSegments });
    legacyOuterId = shellId;
    const hit = await serve("/p/b", { from: "/outside", clientSegments });
    legacyOuterId = undefined;

    expect(
      hit.segments.filter((s) => s.id === shellId).map((s) => s.text),
    ).toEqual([`shell-${calls.shell}`]);
  });

  it("a partial HIT leaves a layout above the boundary to the client that has it", async () => {
    const outside = await serve("/outside");
    const clientSegments = outside.segments
      .filter((s) => s.type === "layout")
      .map((s) => s.id);

    await serve("/p/b", { from: "/outside", clientSegments });
    const pageAfterMiss = calls.page;
    const shellBefore = calls.shell;
    const hit = await serve("/p/b", { from: "/outside", clientSegments });

    expect(calls.shell).toBe(shellBefore);
    expect(textOf(hit, "shell-")).toBeUndefined();
    expect(calls.page).toBe(pageAfterMiss);
    expect(textOf(hit, "b-")).toBe(`b-${pageAfterMiss}`);
  });

  it("a layout between an outer and an inner cache() stays inside the outer boundary", async () => {
    const miss = await serve("/p/nested");
    const innerAfterMiss = calls.inner;
    const shellAfterMiss = calls.shell;
    const hit = await serve("/p/nested");

    expect(calls.inner).toBe(innerAfterMiss);
    expect(textOf(hit, "inner-")).toBe(textOf(miss, "inner-"));
    expect(calls.shell).toBe(shellAfterMiss + 1);
  });

  it("an orphan cache() boundary keeps the layout that declares it live", async () => {
    const miss = await serve("/o");
    const orphanAfterMiss = calls.orphanShell;
    const pageAfterMiss = calls.page;
    const hit = await serve("/o");

    expect(calls.orphanShell).toBe(orphanAfterMiss + 1);
    expect(textOf(hit, "orphan-shell-")).toBe(
      `orphan-shell-${calls.orphanShell}`,
    );
    expect(calls.page).toBe(pageAfterMiss);
    expect(hit.segments.map((s) => s.id)).toEqual(
      miss.segments.map((s) => s.id),
    );
  });

  it("a ppr route's cache() covers the whole chain, which bakes into its shell", async () => {
    const miss = await serve("/ppr");
    const pprShellAfterMiss = calls.pprShell;
    const hit = await serve("/ppr");

    expect(calls.pprShell).toBe(pprShellAfterMiss);
    expect(textOf(hit, "ppr-shell-")).toBe(textOf(miss, "ppr-shell-"));
  });
});
