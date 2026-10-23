/**
 * A client navigation to an intercepted URL that holds no segments
 * (`_rsc_segments=` empty) keeps the page under the intercept (rango-t126).
 *
 * Under an intercept the server never renders the route under it
 * (segment-resolution/revalidation.ts resolveAllSegmentsWithRevalidation):
 * the page underneath comes from the ids the client sends, which `matched`
 * lists (router/match-result.ts buildMatchResult, interceptMatched). With no
 * ids, `matched` is what the server rendered, the layout chain and the slot.
 * The browser keeps the page the answer lands over, as the server lists it
 * for a request that holds it (browser/intercept-utils.ts
 * wholeInterceptMatched, applied by browser/partial-update.ts and the dev HMR
 * refetch in browser/rsc-router.tsx), and renders the layouts and the slot
 * from the answer.
 *
 * The requests are the browser's: an action's redirect followed as a
 * navigation that holds nothing (browser/navigation-bridge.ts navigate,
 * `_skipCache`), and a request from the open intercept naming its source
 * (`X-RSC-Router-Intercept-Source`) that holds nothing (the dev HMR refetch).
 * Through the public serveShellRequest primitive and the browser's own
 * receipt steps. e2e: tests/shared-e2e/src/intercept-whole-request-scenario.ts.
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
import { createRouter, urls } from "../../index.rsc.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { reconcileSegments } from "../../browser/segment-reconciler.js";
import { wholeInterceptMatched } from "../../browser/intercept-utils.js";
import type { ResolvedSegment } from "../../types.js";

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, intercept }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept("@modal", ".item", () => <dialog>modal</dialog>),
        ],
      ),
    ]),
  );
}

interface Metadata {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
}

async function metadataOf(flight: string | undefined): Promise<Metadata> {
  const { metadata } = await deserializeResult<{ metadata: Metadata }>(flight!);
  return metadata;
}

/**
 * The /list page as the browser holds it, its route segment's id, and the
 * answer to `/item/1` asked with `partial`: the server's `matched` and the
 * main tree and slot the browser renders from it.
 */
async function openFromList(
  partial: (held: readonly string[]) => {
    from: string;
    segments: readonly string[];
    interceptSource?: string;
  },
) {
  const router = makeRouter();
  const list = await metadataOf(
    (await serveShellRequest(router, "/list", { partial: { from: "/" } }))
      .flight,
  );
  const listRoute = list.segments.find((s) => s.type === "route")!;
  const sent = partial(list.matched);
  const answer = await metadataOf(
    (await serveShellRequest(router, "/item/1", { partial: sent })).flight,
  );
  // browser/partial-update.ts: a request that held nothing.
  const matched =
    (sent.segments.length === 0
      ? wholeInterceptMatched(list.segments, answer)
      : undefined) ?? answer.matched;
  const reconciled = reconcileSegments({
    actor: "navigation",
    matched,
    diff: answer.diff,
    serverSegments: answer.segments,
    cachedSegments: list.segments,
    insertMissingDiff: true,
  });
  return {
    listRoute,
    layoutIds: list.matched.filter((id) => id !== listRoute.id),
    served: answer.matched,
    matched,
    main: reconciled.mainSegments.map((s) => s.id),
    sentIds: answer.segments.map((s) => s.id),
    slot: reconciled.interceptSegments.map((s) => s.slot),
  };
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a request for an intercepted URL that holds no segments", () => {
  it("control: a link from /list holding the page opens the intercept over it", async () => {
    const opened = await openFromList((held) => ({
      from: "/list",
      segments: held,
    }));
    expect(opened.slot).toContain("@modal");
    expect(opened.served).toContain(opened.listRoute.id);
    expect(opened.main).toContain(opened.listRoute.id);
  });

  it("an action's redirect from /list (nothing held) opens the intercept over the /list the browser holds", async () => {
    const opened = await openFromList(() => ({ from: "/list", segments: [] }));
    // The server's answer is unchanged: the layouts and the slot.
    expect(opened.served).toEqual([...opened.layoutIds, "M0L0L0.@modal"]);
    expect(opened.slot).toContain("@modal");
    expect(opened.matched).toEqual([
      ...opened.layoutIds,
      opened.listRoute.id,
      "M0L0L0.@modal",
    ]);
    expect(opened.main).toEqual([...opened.layoutIds, opened.listRoute.id]);
    // /list is the browser's copy; the layouts and the slot are the answer's.
    expect(opened.sentIds).toEqual([...opened.layoutIds, "M0L0L0.@modal"]);
  });

  it("a request from the open intercept naming /list as its source (nothing held) keeps /list under it", async () => {
    const opened = await openFromList(() => ({
      from: "/item/1",
      segments: [],
      interceptSource: "/list",
    }));
    expect(opened.served).toEqual([...opened.layoutIds, "M0L0L0.@modal"]);
    expect(opened.slot).toContain("@modal");
    expect(opened.main).toEqual([...opened.layoutIds, opened.listRoute.id]);
  });
});
