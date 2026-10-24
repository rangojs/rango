/**
 * A server component a "use cache" function returns renders when the value
 * is stored, as part of that function: a cookies() or headers() read there
 * refuses as one in the body does. The entry is not written (the refusal is
 * reported to onError), the visitor's own request still renders live, and the
 * first visitor's value is never served to the next. Served through the
 * public serveShellRequest, on a miss and on a stale entry's refresh.
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
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import {
  Block,
  PropsBlock,
  RefreshBlock,
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
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a server component a "use cache" function returns', () => {
  it.each(KINDS)(
    "%s(): a miss stores nothing, and the next visitor sees their own value",
    async (kind) => {
      const { serve, messages } = setup();

      const first = await serve(`/miss/${kind}`, "alice");
      const second = await serve(`/miss/${kind}`, "bob");

      expect(second.body).not.toContain("alice");
      expect(first.body).toContain(`${kind}=alice`);
      expect(second.body).toContain(`${kind}=bob`);
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
    expect(first.body).toContain("written");
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
