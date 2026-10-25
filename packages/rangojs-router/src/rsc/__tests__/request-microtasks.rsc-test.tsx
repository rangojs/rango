/**
 * Microtask hops on the request path of createRSCHandler (the
 * `@rangojs/router/rsc` export). Each await the handler puts between a
 * request and its response costs a microtask turn on every request, so the
 * counts are pinned: a change that adds or removes one fails here and is
 * weighed on purpose. A changed count is not a defect in itself; update it
 * and name the hop and its cause in the PR.
 *
 * Counted as the turns a self-requeuing microtask takes before an
 * observation point in route code. Only router code is counted: a document
 * is observed up to its route middleware, and from its global middleware's
 * next() to the response, so React's render in between stays out. A
 * response route's whole path is router code.
 *
 * Origin of the hops the request stages add (rsc/request-stages.ts): classify
 * and runRequestPasses add one each to every request, serveResponseRoute one
 * to a response route. terminalPlanResponse is synchronous and the handler
 * awaits checkRequestOrigin only for the modes ORIGIN_CHECK_PHASE_BY_MODE
 * gates, so the guard adds none.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);

import { createRouter, urls } from "../../index.rsc.js";
import { createRSCHandler } from "../handler.js";
import { ensureRouterManifest } from "../../route-map-builder.js";
import { toInternal, type Rango } from "../../router/router-interfaces.js";
import type { SSRModule } from "../types.js";

/** Stops the counter, so a macrotask boundary on the path cannot hang the run. */
const MAX_TURNS = 10_000;

interface Counter {
  turns: number;
  stopped: boolean;
}

let counter: Counter | undefined;
const marks = new Map<string, number>();

function startCounter(): Counter {
  const started: Counter = { turns: 0, stopped: false };
  const turn = (): void => {
    if (started.stopped || started.turns >= MAX_TURNS) return;
    started.turns++;
    queueMicrotask(turn);
  };
  queueMicrotask(turn);
  return started;
}

function mark(name: string): void {
  if (counter && !counter.stopped && !marks.has(name)) {
    marks.set(name, counter.turns);
  }
}

// The HTML step passes the Flight stream through: react-dom/server does not
// load under the react-server condition this project runs with.
const ssrModule: SSRModule = { renderHTML: async (rscStream) => rscStream };

const router = createRouter({ id: "request-microtasks" })
  .use("/page/*", async (_ctx, next) => {
    await next();
    mark("next-returned");
  })
  .routes(
    urls(({ path, middleware }) => [
      path(
        "/page/:id",
        () => <main>page</main>,
        { name: "page" },
        () => [
          middleware(async (_ctx, next) => {
            mark("route-middleware");
            await next();
          }),
        ],
      ),
      path.json(
        "/api/data",
        () => {
          mark("handler");
          return { ok: true };
        },
        { name: "api.data" },
      ),
    ]),
  );

async function serve(url: string): Promise<{
  status: number;
  turns: number;
  marks: Map<string, number>;
}> {
  await ensureRouterManifest(router.id);
  const handler = createRSCHandler({
    router: toInternal(router as Rango<any, any>),
    loadSSRModule: async () => ssrModule,
  });
  // Warm: the first requests load lazy modules, which crosses macrotasks.
  for (let i = 0; i < 3; i++) await (await handler(new Request(url))).text();

  marks.clear();
  counter = startCounter();
  const response = await handler(new Request(url));
  const turns = counter.turns;
  counter.stopped = true;
  await response.text();
  expect(turns, "a macrotask boundary on the path").toBeLessThan(MAX_TURNS);
  return { status: response.status, turns, marks: new Map(marks) };
}

describe("request path microtask hops", () => {
  it("document request: to the route middleware, and from the global chain to the response", async () => {
    const result = await serve("http://localhost/page/1");
    expect(result.status).toBe(200);
    expect({
      toRouteMiddleware: result.marks.get("route-middleware"),
      fromGlobalChainToResponse:
        result.turns - result.marks.get("next-returned")!,
    }).toEqual({ toRouteMiddleware: 7, fromGlobalChainToResponse: 9 });
  });

  it("response route: to the handler and to the response", async () => {
    const result = await serve("http://localhost/api/data");
    expect(result.status).toBe(200);
    expect({
      toHandler: result.marks.get("handler"),
      toResponse: result.turns,
    }).toEqual({ toHandler: 8, toResponse: 22 });
  });
});
