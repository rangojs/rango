/**
 * A link inside an open intercept to another item of the intercepted route:
 * the request carries the intercept's URL as the page left, the ids held and
 * the source page in `interceptSource`. The item opens in the intercept,
 * `when` sees `from` as the source, and the slot's loader re-runs.
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
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import type { InterceptSelectorContext } from "../../server/context.js";

const loaderRuns: string[] = [];
const ItemLoader = createLoader(async (ctx) => {
  loaderRuns.push(ctx.params.id!);
  return { id: ctx.params.id };
});

const froms: string[] = [];

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, intercept, loader }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list/:id", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item page</article>, {
            name: "item",
          }),
          intercept(
            "@modal",
            ".item",
            (ctx) => <dialog>modal {ctx.params.id}</dialog>,
            {
              when: (ctx: InterceptSelectorContext) => {
                froms.push(ctx.from.url.pathname);
                return ctx.from.routeName === "list";
              },
            },
            () => [loader(ItemLoader)],
          ),
        ],
      ),
    ]),
  );
}

interface Metadata {
  matched: string[];
  segments: Array<{ id: string; namespace?: string }>;
}

function metadataOf(flight: string | undefined): Metadata {
  const row = flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return JSON.parse(row!.slice(2)).metadata as Metadata;
}

function interceptIds(metadata: Metadata): string[] {
  return metadata.segments
    .filter((segment) => segment.namespace?.startsWith("intercept:"))
    .map((segment) => segment.id);
}

beforeEach(() => {
  resetShellTestState();
  loaderRuns.length = 0;
  froms.length = 0;
});

describe("a link inside an open intercept", () => {
  async function openIntercept(router: ReturnType<typeof makeRouter>) {
    const serve = (url: string, partial: Record<string, unknown>) =>
      serveShellRequest(router, url, {
        cacheStore: new MemorySegmentCacheStore(),
        partial,
      });
    const list = metadataOf((await serve("/list/1", { from: "/" })).flight);
    const opened = metadataOf(
      (await serve("/item/2", { from: "/list/1", segments: list.matched }))
        .flight,
    );
    expect(interceptIds(opened).length).toBeGreaterThan(0);
    expect(loaderRuns).toEqual(["2"]);
    return { serve, held: opened.matched };
  }

  it("opens the other item in the intercept, resolved from the source page, and re-runs the slot's loader", async () => {
    const { serve, held } = await openIntercept(makeRouter());
    froms.length = 0;

    const result = await serve("/item/1", {
      from: "/item/2",
      interceptSource: "/list/1",
      segments: held,
    });

    const metadata = metadataOf(result.flight);
    const sent = interceptIds(metadata);
    expect(sent.some((id) => id.endsWith(".@modal"))).toBe(true);
    expect(sent.some((id) => id.includes(".@modalD0."))).toBe(true);
    expect(result.flight).toContain("modal");
    expect(result.flight).not.toContain("item page");
    expect(froms).toEqual(["/list/1"]);
    expect(loaderRuns).toEqual(["2", "1"]);
  });

  it("control: from the intercept's URL with no source, the same route is not intercepted", async () => {
    const { serve, held } = await openIntercept(makeRouter());

    const result = await serve("/item/1", { from: "/item/2", segments: held });

    expect(interceptIds(metadataOf(result.flight))).toEqual([]);
    expect(result.flight).toContain("item page");
  });
});
