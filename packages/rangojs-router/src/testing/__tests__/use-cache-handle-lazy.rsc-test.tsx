/**
 * What a "use cache" function pushes into a handle is encoded inside the
 * function's guard, and a miss delivers the decoded copy, as a hit does. So
 * lazy state the body creates and pushes (a React.lazy, a memoizing thenable),
 * or a loader it reads pushes, is started only by that encode: a cookies()
 * read in it refuses as one in the body does, and the first visitor's value
 * is never stored for the next,
 * however long the returned value takes to encode. Lazy state that reads
 * nothing request-scoped is stored and replayed on the next request. The
 * copies reach the page before the call returns, among the caller's own
 * pushes where the live values were. Served through the public
 * serveShellRequest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  LazyComponentBlock,
  LazyLabels,
  LoaderThenableBlock,
  MiddleBlock,
  NestedThenableBlock,
  PlainLazyBlock,
  ThenableBlock,
  state,
} from "./fixtures/use-cache-handle-lazy-data.js";

const SHAPES = {
  "lazy-component": LazyComponentBlock,
  thenable: ThenableBlock,
  "nested-thenable": NestedThenableBlock,
  "loader-thenable": LoaderThenableBlock,
} as const;

function setup() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const errors: unknown[] = [];
  const router = createRouter({
    onError: (context) => {
      errors.push(context.error);
    },
  }).routes(
    urls(({ path }) => [
      path(
        "/shape/:shape",
        async (ctx) => {
          const block = SHAPES[ctx.params.shape as keyof typeof SHAPES];
          return <div>{await block(ctx)}</div>;
        },
        { name: "shape" },
      ),
      path("/plain", async (ctx) => <div>{await PlainLazyBlock(ctx)}</div>, {
        name: "plain",
      }),
      path(
        "/order",
        async (ctx) => {
          ctx.use(LazyLabels)("label-before");
          const middle = await MiddleBlock(ctx);
          ctx.use(LazyLabels)("label-after");
          return <div>{middle}</div>;
        },
        { name: "order" },
      ),
    ]),
  );
  const cacheStore = new MemorySegmentCacheStore();
  const serve = async (url: string, visitor: string) => {
    const served = await serveShellRequest(router, url, {
      cacheStore,
      headers: { cookie: `session=${visitor}` },
    });
    // The miss stores its entry in a background task: let it land.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return served;
  };
  const messages = () => errors.map((e) => (e as Error).message);
  return { serve, messages };
}

const refusal = 'cookies() cannot be called inside a "use cache" function';

beforeEach(async () => {
  state.starts = 0;
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lazy state a "use cache" function pushes into a handle', () => {
  it.each(Object.keys(SHAPES))(
    "%s reading the visitor: refused, as in the body, and never stored for the next visitor",
    async (shape) => {
      const { serve, messages } = setup();

      const first = await serve(`/shape/${shape}`, "alice");
      const second = await serve(`/shape/${shape}`, "bob");

      expect(first.body).toContain("slow-leaf");
      expect(second.body).toContain("slow-leaf");
      expect(second.body).not.toContain("alice");
      expect(first.body).not.toContain("=alice");
      expect(messages()).toContainEqual(expect.stringContaining(refusal));
    },
  );

  it("reading nothing request-scoped: started once, by the encode, and replayed on the next request", async () => {
    const { serve, messages } = setup();

    const first = await serve("/plain", "alice");
    const second = await serve("/plain", "bob");

    for (const served of [first, second]) {
      expect(served.body).toContain("plain-lazy");
      expect(served.body).toContain("plain-thenable");
      expect(served.body).toContain("slow-leaf");
      // A loader's push stays credited to it (the browser's pushedBy).
      expect(served.body).toMatch(
        /LazyLabels\\+u0000pushedBy[^}]*__rango_runtime_loader_\d+\\*",null\]/,
      );
    }
    expect(state.starts).toBe(2);
    expect(messages()).toEqual([]);
  });
});

describe('a "use cache" miss delivers its pushes before it returns', () => {
  it("between the caller's pushes before and after the call, on the miss and on the hit", async () => {
    const { serve, messages } = setup();

    const miss = await serve("/order", "alice");
    const hit = await serve("/order", "bob");

    for (const served of [miss, hit]) {
      const at = ["label-before", "label-middle", "label-after"].map((label) =>
        served.body.indexOf(label),
      );
      expect(at.every((i) => i >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
    expect(messages()).toEqual([]);
  });
});
