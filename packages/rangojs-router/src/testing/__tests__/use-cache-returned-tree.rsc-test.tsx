/**
 * What a "use cache" function returns is encoded once, inside the function's
 * guard, and a miss renders the decoded copy, as a hit does. So a cookies()
 * or headers() read in a server component it returns refuses as one in the
 * body does: at the value's root it fails the request, below the root it
 * fails that subtree, and the first visitor's value is never stored for the
 * next. A value Flight cannot encode (a class instance) is not stored and
 * renders live, as it always has. Served through the public
 * serveShellRequest, on a miss and on a stale entry's refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { runInRequestContext } from "../index.js";
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import {
  Block,
  HandleBlock,
  NestedBlock,
  PriceBlock,
  PropsBlock,
  RefreshBlock,
  TaggedBlock,
  WriteBlock,
  state,
  type Kind,
} from "./fixtures/use-cache-returned-tree-data.js";

const KINDS: Kind[] = ["cookies", "headers"];

function setup() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const errors: unknown[] = [];
  const router = createRouter({
    cacheProfiles: { short: { ttl: 1, swr: 300 } },
    onError: (context) => {
      errors.push(context.error);
    },
  }).routes(
    urls(({ path }) => [
      path(
        "/miss/:kind",
        async (ctx) => <div>{await Block(ctx.params.kind as Kind)}</div>,
        { name: "miss" },
      ),
      path(
        "/nested/:kind",
        async (ctx) => <div>{await NestedBlock(ctx.params.kind as Kind)}</div>,
        { name: "nested" },
      ),
      path(
        "/refresh/:kind",
        async (ctx) => <div>{await RefreshBlock(ctx.params.kind as Kind)}</div>,
        { name: "refresh" },
      ),
      path("/props", async () => <div>{await PropsBlock("ada")}</div>, {
        name: "props",
      }),
      path("/write", async (ctx) => <div>{await WriteBlock(ctx)}</div>, {
        name: "write",
      }),
      path(
        "/price",
        async () => {
          const item = await PriceBlock("tea");
          return <p>{`${item.sku} ${item.price.format()}`}</p>;
        },
        { name: "price" },
      ),
      path("/handle", async (ctx) => <div>{await HandleBlock(ctx)}</div>, {
        name: "handle",
      }),
    ]),
  );
  const cacheStore = new MemorySegmentCacheStore();
  const serve = (url: string, visitor: string) =>
    serveShellRequest(router, url, {
      cacheStore,
      headers: { cookie: `session=${visitor}`, "x-visitor": visitor },
    });
  const messages = () => errors.map((e) => (e as Error).message);
  return { serve, messages };
}

/** Date.now moves; timers stay real, so a stale entry needs no sleeping. */
function movableClock(): { advance(ms: number): void } {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  return { advance: (ms) => (offset += ms) };
}

const refusal = (kind: Kind) =>
  `${kind}() cannot be called inside a "use cache" function`;

beforeEach(async () => {
  state.readOnRefresh = false;
  state.propsRuns = 0;
  state.dataRuns = 0;
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a server component a "use cache" function returns', () => {
  it.each(KINDS)(
    "%s() at the value's root: fails the request, as in the body, and the next visitor never sees the first one's value",
    async (kind) => {
      const { serve, messages } = setup();

      const first = await serve(`/miss/${kind}`, "alice");
      const second = await serve(`/miss/${kind}`, "bob");

      expect(second.body).not.toContain("alice");
      expect([first, second].map((s) => s.response.status)).toEqual([500, 500]);
      expect(first.body).not.toContain(`${kind}=alice`);
      // Reported once per request, by the route, as a read in the body is.
      expect(
        messages().filter((message) => message.includes(refusal(kind))),
      ).toHaveLength(2);
    },
  );

  it.each(KINDS)(
    "%s() below the value's root: that subtree renders as an error, as on a hit, and nothing is stored",
    async (kind) => {
      const { serve, messages } = setup();

      const first = await serve(`/nested/${kind}`, "alice");
      const second = await serve(`/nested/${kind}`, "bob");

      expect(second.body).not.toContain("alice");
      // The rest of the value renders; the reader's place is a Flight error
      // row, which throws to the nearest error boundary where it renders.
      for (const response of [first, second]) {
        expect(response.body).toContain("nested");
        expect(response.body).toMatch(/\n\d+:E\{/);
      }
      expect(first.body).not.toContain(`${kind}=alice`);
      expect(messages()).toContainEqual(expect.stringContaining(refusal(kind)));
    },
  );

  it.each(KINDS)(
    "%s(): a stale refresh keeps the stale entry instead of storing the visitor's value",
    async (kind) => {
      const clock = movableClock();
      const { serve, messages } = setup();

      const first = await serve(`/refresh/${kind}`, "alice");
      expect(first.body).toContain("first-value");
      clock.advance(1_500);
      state.readOnRefresh = true;
      // Serves the stale entry; its refresh renders the reader for bob.
      const stale = await serve(`/refresh/${kind}`, "bob");
      const next = await serve(`/refresh/${kind}`, "carol");

      expect(next.body).not.toContain("bob");
      expect(stale.body).toContain("first-value");
      expect(next.body).toContain("first-value");
      expect(messages()).toContainEqual(expect.stringContaining(refusal(kind)));
    },
  );

  it("a ctx write: refused, as one in the body is, instead of stored and lost on a hit", async () => {
    const { serve, messages } = setup();

    const first = await serve("/write", "alice");

    expect(messages()).toContainEqual(
      expect.stringContaining(
        'ctx.set() cannot be called inside a "use cache" function',
      ),
    );
    expect(first.response.status).toBe(500);
  });

  it("a handle value that reads the visitor: not stored, so the next visitor never sees the first one's", async () => {
    const { serve, messages } = setup();

    await serve("/handle", "alice");
    const second = await serve("/handle", "bob");

    expect(second.body).not.toContain("alice");
    expect(second.body).toContain("handle-block");
    expect(messages()).toContainEqual(
      expect.stringContaining(refusal("cookies")),
    );
  });

  it("one that reads only its props is stored and served on the next request", async () => {
    const { serve, messages } = setup();

    await serve("/props", "alice");
    const second = await serve("/props", "bob");

    expect(second.body).toContain("hello ada");
    expect(state.propsRuns).toBe(1);
    expect(messages()).toEqual([]);
  });
});

describe('a "use cache" value Flight cannot encode', () => {
  it("a class instance: not stored, and each request gets the live value", async () => {
    const { serve, messages } = setup();

    const first = await serve("/price", "alice");
    const second = await serve("/price", "bob");

    expect([first, second].map((s) => s.response.status)).toEqual([200, 200]);
    expect(second.body).toContain("tea $2.50");
    expect(state.dataRuns).toBe(2);
    expect(messages()).toContainEqual(
      expect.stringContaining("Only plain objects"),
    );
    expect(messages().some((m) => m.includes("cannot be called inside"))).toBe(
      false,
    );
  });
});

describe("the tags a returned component records", () => {
  it("reach the request on a miss, as a hit replays them", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const options = { cacheStore, cacheProfiles: { default: { ttl: 60 } } };
    const requestTags = () =>
      runInRequestContext(async (ctx) => {
        await TaggedBlock("shelf");
        // The miss records them once its encode, a background task, ends.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [...ctx._requestTags];
      }, options);

    const miss = await requestTags();
    const hit = await requestTags();

    expect(hit.result).toContain("returned-tree-tag");
    expect(miss.result).toContain("returned-tree-tag");
  });
});
