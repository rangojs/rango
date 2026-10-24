/**
 * A middleware that answers with its own Response while the next() it called
 * still runs (a timeout fallback, a fire-and-forget render, a throw a
 * middleware ahead catches) answers the request with that Response. The
 * middleware ahead of it see that Response after next() and write on it,
 * even when their post-next() work outlasts the abandoned render, which
 * builds its own response.
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
import {
  createRouter,
  rewrite,
  urls,
  type MiddlewareFn,
} from "../../index.rsc.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Case {
  /** The middleware ahead returns nothing after next(). */
  forgiving: boolean;
  /** The middleware after the one ahead. */
  answer: MiddlewareFn;
  /** The middleware after that one. */
  inner?: MiddlewareFn;
}

let current: Case;
/** The render the answering middleware abandoned. */
let abandoned: Promise<Response> | undefined;

/** Its post-next() work outlasts the abandoned render, as a log flush can. */
const ahead: MiddlewareFn = async (ctx, next) => {
  const response = await next();
  ctx.header("x-ahead-post", "1");
  await abandoned?.catch(() => {});
  ctx.header("x-ahead-later", "1");
  return current.forgiving ? undefined : response;
};

const abandon = (next: () => Promise<Response>): Promise<Response> => {
  const render = next();
  render.catch(() => {});
  abandoned = render;
  return render;
};

const timeoutFallback: MiddlewareFn = (_ctx, next) =>
  Promise.race([
    abandon(next),
    sleep(5).then(() => new Response("render timed out", { status: 503 })),
  ]);

async function SlowPage(): Promise<React.ReactNode> {
  await sleep(40);
  return <p>SlowPage</p>;
}

const router = createRouter()
  .use(ahead)
  .use((ctx, next) => current.answer(ctx, next))
  .use((ctx, next) => (current.inner ? current.inner(ctx, next) : next()))
  .routes(urls(({ path }) => [path("/slow", SlowPage, { name: "slow" })]));

async function serve(
  options: Case,
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  current = options;
  const { response, body } = await serveShellRequest(router, "/slow");
  return {
    status: response.status,
    body,
    headers: {
      post: response.headers.get("x-ahead-post"),
      later: response.headers.get("x-ahead-later"),
    },
  };
}

const AHEAD_WROTE = { post: "1", later: "1" };

beforeEach(async () => {
  await resetShellTestState();
  abandoned = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a middleware that answers while the next() it called still runs", () => {
  it.each([
    ["returns nothing after next()", true],
    ["returns its response", false],
  ])(
    "answers a timeout fallback's Response; the middleware ahead %s and writes on it",
    async (_label, forgiving) => {
      expect(await serve({ forgiving, answer: timeoutFallback })).toEqual({
        status: 503,
        body: "render timed out",
        headers: AHEAD_WROTE,
      });
    },
  );

  it("answers a fire-and-forget middleware's Response", async () => {
    const result = await serve({
      forgiving: false,
      answer: async (_ctx, next) => {
        abandon(next);
        return new Response("accepted", { status: 202 });
      },
    });
    expect(result).toEqual({
      status: 202,
      body: "accepted",
      headers: AHEAD_WROTE,
    });
  });

  // A rewrite made after next() started the render is an error
  // (router/middleware.ts rewriteAfterNextError, returnedRewriteError).
  it.each<[string, MiddlewareFn]>([
    [
      "throws",
      async (_ctx, next) => {
        abandon(next);
        throw new Error("inner failed");
      },
    ],
    [
      "throws rewrite()",
      async (_ctx, next) => {
        abandon(next);
        throw rewrite("/elsewhere");
      },
    ],
    [
      "returns rewrite()",
      (async (_ctx: unknown, next: () => Promise<Response>) => {
        abandon(next);
        return rewrite("/elsewhere");
      }) as unknown as MiddlewareFn,
    ],
  ])(
    "answers the fallback of a middleware ahead that catches when one %s while next() runs",
    async (_label, inner) => {
      const result = await serve({
        forgiving: true,
        answer: async (_ctx, next) => {
          try {
            return await next();
          } catch {
            return new Response("fallback", { status: 500 });
          }
        },
        inner,
      });
      expect(result).toEqual({
        status: 500,
        body: "fallback",
        headers: AHEAD_WROTE,
      });
    },
  );
});
