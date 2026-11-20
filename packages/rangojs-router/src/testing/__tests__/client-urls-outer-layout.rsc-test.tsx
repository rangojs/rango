/**
 * A server layout() around a clientUrls() group holds on the group's
 * navigations and actions by default, and revalidate() on it opts it in,
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
import type { ShouldRevalidateFn } from "../../types.js";
import group from "./fixtures/client-urls-outer-layout.js";
import {
  bump,
  cartAction,
  chromeChanged,
  count,
  events,
  otherAction,
  resetRuns,
} from "./fixtures/client-urls-outer-layout-data.js";

const CART_ACTION = "src/shop.actions.ts#cartAction";
const OTHER_ACTION = "src/shop.actions.ts#otherAction";

/** A router whose server layout around the group takes `rule`, if any. */
function routerWith(rule: ShouldRevalidateFn | undefined) {
  return createRouter({}).routes(
    urls(({ path, layout, include, revalidate }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/", () => <p>home</p>, { name: "home" }),
          layout(
            async () => {
              events.push("chrome:start");
              await new Promise((resolve) => setTimeout(resolve, 20));
              bump("chrome");
              events.push("chrome:end");
              return <header>chrome {count("chrome")}</header>;
            },
            () => [
              ...(rule ? [revalidate(rule)] : []),
              include("/shop", group, { name: "shop" }),
            ],
          ),
        ],
      ),
    ]),
  );
}

interface Metadata {
  matched: string[];
  diff: string[];
  segments: { id: string; type: string }[];
}

function metadataOf(result: ServeShellRequestResult): Metadata {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  return JSON.parse(row!.slice(2)).metadata;
}

/**
 * The layout segments a partial response re-renders. The page already holds
 * every layout here, so any one listed is a layout that re-ran.
 */
const layoutsSent = ({ segments }: Metadata): string[] =>
  segments.filter((s) => s.type === "layout").map((s) => s.id);

function setup(rule: ShouldRevalidateFn | undefined) {
  const router = routerWith(rule);
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
  const act = async (
    at: string,
    held: string[],
    ref: () => Promise<void>,
    id: string,
  ) => {
    const result = await serve(at, {
      action: { ref, id, args: [], segments: held },
    });
    expect(result.response.status).toBe(200);
  };
  return { navigate, standingOn, act };
}

const runCounts = () => ({
  chrome: count("chrome"),
  badge: count("badge"),
  item: count("item"),
});

beforeEach(async () => {
  resetRuns();
  await resetShellTestState();
});

describe("a server layout() around a clientUrls() group", () => {
  it("with no revalidate() holds on every navigation and action in the group", async () => {
    const { navigate, standingOn, act } = setup(undefined);

    let held = await standingOn("/shop/items/a");
    await navigate("/shop/items/a", held, "/shop/items/b");
    expect(runCounts()).toEqual({ chrome: 0, badge: 0, item: 1 });

    held = await standingOn("/shop/items/a");
    const toCart = await navigate("/shop/items/a", held, "/shop/cart");
    // The badge loader's own predicate still re-runs it; the chrome holds.
    expect(runCounts()).toEqual({ chrome: 0, badge: 1, item: 0 });
    expect(layoutsSent(toCart)).toEqual([]);

    held = await standingOn("/shop");
    await act("/shop", held, cartAction, CART_ACTION);
    expect(count("chrome")).toBe(0);
  });

  it("with revalidate(() => true) re-runs on every navigation and every action", async () => {
    const { navigate, standingOn, act } = setup(() => true);

    let held = await standingOn("/shop/items/a");
    await navigate("/shop/items/a", held, "/shop/items/b");
    expect(count("chrome")).toBe(1);

    held = await standingOn("/shop/items/a");
    await navigate("/shop/items/a", held, "/shop");
    expect(count("chrome")).toBe(1);

    held = await standingOn("/shop");
    await act("/shop", held, otherAction, OTHER_ACTION);
    expect(count("chrome")).toBe(1);
  });

  it("with the group loader's predicate re-runs together with that loader, and holds where it holds", async () => {
    const { navigate, standingOn, act } = setup(chromeChanged);

    // A navigation the predicate does not name: both hold.
    let held = await standingOn("/shop/items/a");
    await navigate("/shop/items/a", held, "/shop/items/b");
    expect(runCounts()).toEqual({ chrome: 0, badge: 0, item: 1 });

    // Into the cart route: both re-run, in the same response.
    held = await standingOn("/shop/items/a");
    const toCart = await navigate("/shop/items/a", held, "/shop/cart");
    expect(runCounts()).toEqual({ chrome: 1, badge: 1, item: 0 });
    // The chrome layout's segment, which the page holds, is sent again.
    const [chrome] = layoutsSent(toCart);
    expect(layoutsSent(toCart)).toEqual([chrome]);
    expect(held).toContain(chrome);
    expect(toCart.diff).toContain(chrome);

    // The named action: both re-run.
    held = await standingOn("/shop");
    await act("/shop", held, cartAction, CART_ACTION);
    expect(runCounts()).toEqual({ chrome: 1, badge: 1, item: 0 });

    // Another action: both hold.
    held = await standingOn("/shop");
    await act("/shop", held, otherAction, OTHER_ACTION);
    expect(runCounts()).toEqual({ chrome: 0, badge: 0, item: 0 });
  });

  it("runs its handler to the end before the group's loaders start, so its time adds to the response", async () => {
    const { navigate, standingOn } = setup(() => true);
    const held = await standingOn("/shop/items/a");

    await navigate("/shop/items/a", held, "/shop/items/b");
    expect(events).toEqual(["chrome:start", "chrome:end", "item:start"]);
  });
});
