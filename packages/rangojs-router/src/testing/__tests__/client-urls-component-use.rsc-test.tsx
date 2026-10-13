/**
 * A clientUrls() component's own items (`Dashboard.use = () => [...]`, the
 * server handler.use pattern), through public primitives: its loader runs,
 * its loading() is the route's, and its revalidate() predicate decides on the
 * server, for a navigation and for an action.
 *
 * The component lives in its own "use client" module, apart from the group;
 * rangoUseClientTransform (vitest.rsc.config.ts) installs the group's
 * projection, its components' items and predicates included, as discovery
 * and the hoist plugin do in an app.
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
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import group from "./fixtures/client-urls-component-use.js";
import {
  bumpStats,
  count,
  otherAction,
  resetRuns,
} from "./fixtures/client-urls-component-use-data.js";

const BUMP = "src/dash.actions.ts#bumpStats";
const OTHER = "src/dash.actions.ts#otherAction";

const errors: string[] = [];

const router = createRouter({
  onError: ({ error }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
}).routes(
  urls(({ path, layout, include }) => [
    layout(
      () => <main>shell</main>,
      () => [
        path("/", () => <p>home</p>, { name: "home" }),
        include("/dash", group, { name: "dash" }),
      ],
    ),
  ]),
);

interface PayloadSegment {
  id: string;
  type: string;
  loading?: unknown;
}

function payloadOf(result: ServeShellRequestResult): {
  matched: string[];
  segments: PayloadSegment[];
} {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  return JSON.parse(row!.slice(2)).metadata;
}

function setup() {
  const cacheStore = new MemorySegmentCacheStore();
  const serve = (
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(router, url, { cacheStore, ...extra });
  /** The segment ids a page holds after a navigation to it; runs reset. */
  const standingOn = async (at: string): Promise<string[]> => {
    const { matched } = payloadOf(await serve(at, { partial: { from: "/" } }));
    resetRuns();
    return matched;
  };
  return { serve, standingOn };
}

beforeEach(async () => {
  resetRuns();
  errors.length = 0;
  await resetShellTestState();
});

describe("clientUrls() Component.use", () => {
  it("the page and layout components' loaders run, and the page's loading() is its route's", async () => {
    const { serve } = setup();
    const dash = await serve("/dash", { partial: { from: "/" } });
    expect(dash.response.status).toBe(200);
    expect({ stats: count("stats"), cart: count("cart") }).toEqual({
      stats: 1,
      cart: 1,
    });
    // Flight writes an absent fallback as "$undefined".
    const loadingOf = (result: ServeShellRequestResult) => {
      const loading = payloadOf(result).segments.find(
        (segment) => segment.type === "route",
      )?.loading;
      return loading === "$undefined" ? undefined : loading;
    };
    expect(loadingOf(dash)).toBeDefined();

    resetRuns();
    const plain = await serve("/dash/plain", { partial: { from: "/" } });
    // The layout component's loader is the group's; the page's is not here.
    expect({ stats: count("stats"), cart: count("cart") }).toEqual({
      stats: 0,
      cart: 1,
    });
    expect(loadingOf(plain)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("its revalidate() predicate decides on the server: a navigation holds, its action reruns, another action holds", async () => {
    const { serve, standingOn } = setup();

    // A search change: a layout's default keeps the layout's loader; the
    // predicate (isAction(bumpStats)) holds the page's.
    let held = await standingOn("/dash");
    await serve("/dash?tab=2", { partial: { from: "/dash", segments: held } });
    expect({ stats: count("stats"), cart: count("cart") }).toEqual({
      stats: 0,
      cart: 0,
    });

    held = await standingOn("/dash");
    const bumped = await serve("/dash", {
      action: { ref: bumpStats, id: BUMP, args: [], segments: held },
    });
    expect(bumped.response.status).toBe(200);
    // The layout component's loader follows the default: an action reruns it.
    expect({ stats: count("stats"), cart: count("cart") }).toEqual({
      stats: 1,
      cart: 1,
    });

    resetRuns();
    await serve("/dash", {
      action: { ref: otherAction, id: OTHER, args: [], segments: held },
    });
    expect({ stats: count("stats"), cart: count("cart") }).toEqual({
      stats: 0,
      cart: 1,
    });
    expect(errors).toEqual([]);
  });
});
