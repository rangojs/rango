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
  breakAction,
  count,
  flaky,
  resetRuns,
  resultAction,
  scopeAction,
} from "./fixtures/client-urls-revalidate-data.js";

const RESULT_ACTION = "src/shop.actions.ts#resultAction";
const SCOPE_ACTION = "src/shop.actions.ts#scopeAction";
const BREAK_ACTION = "src/shop.actions.ts#breakAction";

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

/**
 * A router that mounts the group under an errorBoundary(), the only place a
 * group's loader errors reach one.
 */
const boundedRouter = createRouter({
  onError: ({ error }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
}).routes(
  urls(({ layout, errorBoundary, include }) => [
    layout(
      () => <main>shell</main>,
      () => [
        errorBoundary(() => <p>The page failed to load</p>),
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

/** The JSON rows of a Flight payload, by row id. */
function jsonRows(result: ServeShellRequestResult): Map<string, any> {
  const rows = new Map<string, any>();
  for (const line of result.flight?.split("\n") ?? []) {
    const match = /^([0-9a-f]+):(\{.*\})$/.exec(line);
    if (match) rows.set(match[1], JSON.parse(match[2]));
  }
  return rows;
}

/** An action response's return value and its loader entries, in order. */
function actionAnswer(result: ServeShellRequestResult): {
  returnValue: unknown;
  loaders: unknown[];
} {
  const rows = jsonRows(result);
  const root = rows.get("0");
  return {
    returnValue: root.returnValue,
    loaders: (root.metadata.segments as { type: string; loaderData: string }[])
      .filter((segment) => segment.type === "loader")
      .map((segment) => rows.get(segment.loaderData.slice(2))),
  };
}

function setup(target: Parameters<typeof serveShellRequest>[0] = router) {
  const cacheStore = new MemorySegmentCacheStore();
  const serve = (
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(target, url, { cacheStore, ...extra });
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
  flaky.failing = false;
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

describe("clientUrls() loader revalidate() answers on navigation", () => {
  it("a predicate that answers true reruns its loader where the default holds it", async () => {
    const { serve, standingOn } = setup();
    const held = await standingOn("/shop/items/a");
    await serve("/shop/items/a", {
      partial: { from: "/shop/items/a", segments: held },
    });
    // Nothing changed: the default holds ItemLoader; revalidate(() => true)
    // reruns ForcedLoader.
    expect({ forced: count("forced"), item: count("item") }).toEqual({
      forced: 1,
      item: 0,
    });
    expect(errors).toEqual([]);
  });

  it("a stale back/forward revalidation runs it with stale: true", async () => {
    const { serve, standingOn } = setup();
    let held = await standingOn("/shop/items/a");
    await serve("/shop/items/a", {
      partial: { from: "/shop/items/a", segments: held },
    });
    expect(count("stale")).toBe(0);

    held = await standingOn("/shop/items/a");
    // The browser marks a stale back/forward revalidation with _rsc_stale.
    await serve("/shop/items/a?_rsc_stale=true", {
      partial: { from: "/shop/items/a", segments: held },
    });
    expect(count("stale")).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe("clientUrls() loader that fails on its rerun after an action", () => {
  const breakCall = (segments: string[]): ServeShellRequestOptions => ({
    action: { ref: breakAction, id: BREAK_ACTION, args: [], segments },
  });

  it("the response carries the action's result, the thrown error as the loader's entry, and the failure returned as data", async () => {
    const { serve, standingOn } = setup();
    const held = await standingOn("/shop/flaky");

    const result = await serve("/shop/flaky", breakCall(held));
    expect(result.response.status).toBe(200);
    const { returnValue, loaders } = actionAnswer(result);
    // The action ran and returned.
    expect(returnValue).toEqual({ ok: true, data: { saved: true } });
    expect(loaders).toEqual([
      // No errorBoundary() above the route: no fallback, so the browser's
      // commit of this revalidation fails and the action call rejects. A
      // build redacts the message; onError gets the error itself.
      expect.objectContaining({
        __loaderResult: true,
        ok: false,
        error: expect.objectContaining({ message: "An error occurred" }),
        fallback: null,
      }),
      // A failure returned as data is an ordinary answer.
      {
        __loaderResult: true,
        ok: true,
        data: { ok: false, reason: "price service unavailable" },
      },
    ]);
    expect(errors).toEqual(["stock service unavailable"]);
    expect({ flaky: count("flaky"), data: count("flaky-data") }).toEqual({
      flaky: 1,
      data: 1,
    });
  });

  it("an errorBoundary() around the mount renders its fallback into the thrown loader's entry", async () => {
    const { serve, standingOn } = setup(boundedRouter);
    const held = await standingOn("/shop/flaky");

    const result = await serve("/shop/flaky", breakCall(held));
    const { returnValue, loaders } = actionAnswer(result);
    expect(returnValue).toEqual({ ok: true, data: { saved: true } });
    expect(loaders[0]).toMatchObject({ ok: false });
    expect((loaders[0] as { fallback: unknown }).fallback).not.toBeNull();
    expect(result.flight).toContain("The page failed to load");
  });
});
