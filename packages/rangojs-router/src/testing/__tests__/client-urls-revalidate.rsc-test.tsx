/**
 * A clientUrls() loader's revalidate() runs on the server with the arguments
 * a urls() loader's predicate gets, through public primitives:
 * serveShellRequest's partial navigation, its JS `action` call and its no-JS
 * `form` post.
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
  createActionForm,
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import group from "./fixtures/client-urls-revalidate.js";
import {
  count,
  resetRuns,
  resultAction,
  scopeAction,
} from "./fixtures/client-urls-revalidate-data.js";

const RESULT_ACTION = "src/shop.actions.ts#resultAction";
const SCOPE_ACTION = "src/shop.actions.ts#scopeAction";

const errors: string[] = [];

const router = createRouter({
  onError: ({ error }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
}).routes(
  urls(({ path, layout, middleware, include }) => [
    layout(
      () => <main>shell</main>,
      () => [
        middleware(async (ctx, next) => {
          ctx.set("flag", ctx.url.searchParams.get("flag") ?? "off");
          await next();
        }),
        path("/", () => <p>home</p>, { name: "home" }),
        include("/shop", group, { name: "shop" }),
      ],
    ),
  ]),
);

function matchedOf(result: ServeShellRequestResult): string[] {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  return (JSON.parse(row!.slice(2)).metadata as { matched: string[] }).matched;
}

function setup() {
  const cacheStore = new MemorySegmentCacheStore();
  const serve = (
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(router, url, { cacheStore, ...extra });
  /** The segment ids a page holds after a navigation to it; runs reset. */
  const standingOn = async (at: string): Promise<string[]> => {
    const matched = matchedOf(await serve(at, { partial: { from: "/" } }));
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

describe("clientUrls() loader revalidate() runs on the server", () => {
  it("a same-route navigation runs it with the request context and route names", async () => {
    const { serve, standingOn } = setup();

    let held = await standingOn("/shop/items/a");
    await serve("/shop/items/b?flag=on", {
      partial: { from: "/shop/items/a", segments: held },
    });
    // The predicate read the middleware's variable and held its loader;
    // the sibling follows the default (params changed: re-run).
    expect({ held: count("held"), item: count("item") }).toEqual({
      held: 0,
      item: 1,
    });

    held = await standingOn("/shop/items/a");
    await serve("/shop/items/b", {
      partial: { from: "/shop/items/a", segments: held },
    });
    expect({ held: count("held"), item: count("item") }).toEqual({
      held: 1,
      item: 1,
    });
    expect(errors).toEqual([]);
  });

  it("a JS action call runs it with the action's result", async () => {
    const { serve, standingOn } = setup();
    const held = await standingOn("/shop");

    const ok = await serve("/shop", {
      action: {
        ref: resultAction,
        id: RESULT_ACTION,
        args: [true],
        segments: held,
      },
    });
    expect(ok.response.status).toBe(200);
    expect(count("result")).toBe(1);

    resetRuns();
    await serve("/shop", {
      action: {
        ref: resultAction,
        id: RESULT_ACTION,
        args: [false],
        segments: held,
      },
    });
    expect(count("result")).toBe(0);
    expect(errors).toEqual([]);
  });

  it("a JS action call runs it with the action's form data", async () => {
    const { serve, standingOn } = setup();
    const held = await standingOn("/shop");
    const form = (scope: string): FormData => {
      const data = new FormData();
      data.set("scope", scope);
      return data;
    };

    await serve("/shop", {
      action: {
        ref: scopeAction,
        id: SCOPE_ACTION,
        args: [form("all")],
        segments: held,
      },
    });
    expect(count("scoped")).toBe(1);

    resetRuns();
    await serve("/shop", {
      action: {
        ref: scopeAction,
        id: SCOPE_ACTION,
        args: [form("none")],
        segments: held,
      },
    });
    expect(count("scoped")).toBe(0);
    expect(errors).toEqual([]);
  });

  it("a no-JS form post renders every group loader, whatever the predicates say", async () => {
    const { serve } = setup();
    const result = await serve("/shop", {
      form: createActionForm(scopeAction, {
        id: SCOPE_ACTION,
        useActionState: false,
        fields: { scope: "none" },
      }),
    });
    expect(result.response.status).toBe(200);
    expect({ result: count("result"), scoped: count("scoped") }).toEqual({
      result: 1,
      scoped: 1,
    });
    expect(errors).toEqual([]);
  });
});
