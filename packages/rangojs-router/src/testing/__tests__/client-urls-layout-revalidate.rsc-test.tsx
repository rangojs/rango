/**
 * A clientUrls() layout()'s loader follows its revalidate() on a navigation
 * between the routes of that layout, as on a param navigation of one route,
 * through public primitives: serveShellRequest's partial navigation and its
 * JS `action` call.
 *
 * The group is mounted as an app mounts it: include() receives the default
 * export of a "use client" module, a client reference here, whose projection
 * and predicates rangoUseClientTransform installed (vitest.rsc.config.ts).
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
import group from "./fixtures/client-urls-layout-revalidate.js";
import {
  HeldLoader,
  bumpAction,
  count,
  resetRuns,
  seenDefaults,
} from "./fixtures/client-urls-layout-revalidate-data.js";

const BUMP_ACTION = "src/shop.actions.ts#bumpAction";

const router = createRouter({}).routes(
  urls(({ path, layout, include }) => [
    layout(
      () => <main>shell</main>,
      () => [
        path("/", () => <p>home</p>, { name: "home" }),
        include("/shop", group, { name: "shop" }),
      ],
    ),
  ]),
);

function metadataOf(result: ServeShellRequestResult): {
  matched: string[];
  diff: string[];
} {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  return JSON.parse(row!.slice(2)).metadata;
}

/** The id `matched` gives HeldLoader's segment. */
function heldLoaderId(matched: readonly string[]): string | undefined {
  return matched.find((id) => id.endsWith(`.${HeldLoader.$$id}`));
}

function runCounts() {
  return {
    held: count("held"),
    action: count("action"),
    forced: count("forced"),
    default: count("default"),
    params: count("params"),
    item: count("item"),
  };
}

function setup() {
  const cacheStore = new MemorySegmentCacheStore();
  const serve = (
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(router, url, { cacheStore, ...extra });
  /** A navigation from `from`, holding what the page there holds. */
  const navigate = async (from: string, held: string[], to: string) =>
    metadataOf(await serve(to, { partial: { from, segments: held } }));
  /** The segment ids a page holds after a navigation to it; runs reset. */
  const standingOn = async (at: string): Promise<string[]> => {
    const { matched } = metadataOf(await serve(at, { partial: { from: "/" } }));
    resetRuns();
    return matched;
  };
  return { serve, navigate, standingOn };
}

beforeEach(async () => {
  resetRuns();
  await resetShellTestState();
});

describe("clientUrls() layout() loader on a navigation between the layout's routes", () => {
  it("holds a loader whose revalidate() answers false and names it under the destination route", async () => {
    const { navigate, standingOn } = setup();
    const held = await standingOn("/shop/items/a");

    const toIndex = await navigate("/shop/items/a", held, "/shop");
    expect(runCounts()).toEqual({
      held: 0,
      action: 0,
      forced: 1,
      default: 0,
      // currentParams.id "a", nextParams.id undefined.
      params: 1,
      item: 0,
    });
    const indexCopy = heldLoaderId(toIndex.matched);
    expect(indexCopy).toBeDefined();
    expect(indexCopy).not.toBe(heldLoaderId(held));
    expect(toIndex.diff).not.toContain(indexCopy);

    resetRuns();
    const toAbout = await navigate("/shop", toIndex.matched, "/shop/about");
    expect(runCounts()).toEqual({
      held: 0,
      action: 0,
      forced: 1,
      default: 0,
      params: 0,
      item: 0,
    });
    expect(toAbout.diff).not.toContain(heldLoaderId(toAbout.matched));
  });

  it("with no revalidate() takes a server layout's default: held on every navigation, re-run on an action", async () => {
    const { serve, navigate, standingOn } = setup();

    // Between two routes of the layout.
    let held = await standingOn("/shop/items/a");
    await navigate("/shop/items/a", held, "/shop");
    expect(count("default")).toBe(0);

    // A param navigation of one route: the route's own loader re-runs.
    held = await standingOn("/shop/items/a");
    await navigate("/shop/items/a", held, "/shop/items/b");
    expect({ default: count("default"), item: count("item") }).toEqual({
      default: 0,
      item: 1,
    });

    // A search-only navigation.
    held = await standingOn("/shop/about");
    await navigate("/shop/about", held, "/shop/about?sort=price");
    expect(count("default")).toBe(0);

    // An action.
    held = await standingOn("/shop");
    await serve("/shop", {
      action: { ref: bumpAction, id: BUMP_ACTION, args: [], segments: held },
    });
    expect(count("default")).toBe(1);
  });

  it("a revalidate() hands its predicate that default and decides", async () => {
    const { serve, navigate, standingOn } = setup();

    let held = await standingOn("/shop/items/a");
    await navigate("/shop/items/a", held, "/shop/items/b");
    // The params rule re-runs ParamsLoader; the default holds the rest.
    expect(runCounts()).toEqual({
      held: 0,
      action: 0,
      forced: 1,
      default: 0,
      params: 1,
      item: 1,
    });
    expect(seenDefaults).toEqual([false]);

    held = await standingOn("/shop");
    await serve("/shop", {
      action: { ref: bumpAction, id: BUMP_ACTION, args: [], segments: held },
    });
    expect(seenDefaults).toEqual([true]);
  });

  it("re-runs it on an action its revalidate() names, on the route the navigation reached", async () => {
    const { serve, navigate, standingOn } = setup();
    const held = await standingOn("/shop/items/a");
    const { matched } = await navigate("/shop/items/a", held, "/shop");
    resetRuns();

    const result = await serve("/shop", {
      action: { ref: bumpAction, id: BUMP_ACTION, args: [], segments: matched },
    });
    expect(result.response.status).toBe(200);
    expect({ held: count("held"), action: count("action") }).toEqual({
      held: 0,
      action: 1,
    });
  });

  it("a prefetch between the layout's routes runs a prefetch: false layout loader its revalidate() re-runs, and holds one with no rule", async () => {
    const { serve, standingOn } = setup();
    const held = await standingOn("/shop/items/a");

    const result = await serve("/shop", {
      partial: { from: "/shop/items/a", segments: held, prefetch: true },
    });
    // The page holds both copies, so the prefetch defers neither: the rule
    // runs one there, and the default holds the other.
    expect({
      flagged: count("flagged"),
      flaggedDefault: count("flagged-default"),
    }).toEqual({ flagged: 1, flaggedDefault: 0 });
    expect(await result.readDeferred()).toEqual([]);
  });

  it("runs every loader of a layout the navigation enters", async () => {
    const { navigate, standingOn } = setup();

    // From the group's route outside the layout.
    let held = await standingOn("/shop/outside");
    await navigate("/shop/outside", held, "/shop");
    expect(runCounts()).toEqual({
      held: 1,
      action: 1,
      forced: 1,
      default: 1,
      params: 1,
      item: 0,
    });

    // From outside the group.
    held = await standingOn("/");
    await navigate("/", held, "/shop/about");
    expect(runCounts()).toEqual({
      held: 1,
      action: 1,
      forced: 1,
      default: 1,
      params: 1,
      item: 0,
    });
  });
});
