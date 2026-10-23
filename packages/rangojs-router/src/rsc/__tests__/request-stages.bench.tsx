/**
 * Per-request cost of the request stages (rsc/request-stages.ts) through both
 * callers: createRSCHandler (`@rangojs/router/rsc`) and dispatch
 * (`@rangojs/router/testing`). Each sample is one request, timed from the call
 * to the end of its body read. React renders the document, Flight and 404
 * document requests, so those measure the whole request; the response routes,
 * the 308 and dispatch are router code only.
 *
 * Runs in the rsc project (react-server condition, production React):
 *
 *   ./node_modules/.bin/vitest bench --run --config vitest.rsc.config.ts src/rsc/__tests__/request-stages.bench.tsx
 *
 * To compare two revisions, run it in both checkouts alternately, several
 * times each, on a quiet machine; one run's spread is wider than the stages'
 * cost.
 */
import { bench, describe, vi } from "vitest";
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
import { dispatch } from "../../testing/dispatch.js";
import { ensureRouterManifest } from "../../route-map-builder.js";
import { toInternal, type Rango } from "../../router/router-interfaces.js";
import type { SSRModule } from "../types.js";

const WARMUP_REQUESTS = 200;
const TIMED_REQUESTS = 2000;
const ORIGIN = "http://localhost";

// The HTML step passes the Flight stream through: react-dom/server does not
// load under the react-server condition this project runs with.
const ssrModule: SSRModule = { renderHTML: async (rscStream) => rscStream };

function Page() {
  return <main>page</main>;
}

const router = createRouter({ id: "request-stages-bench" })
  .use("/api/*", async (_ctx, next) => {
    await next();
  })
  .routes(
    urls(({ path }) => [
      path("/", Page, { name: "home" }),
      path("/page/:id", Page, { name: "page" }),
      path.json("/api/data", () => ({ hello: "world" }), { name: "api.data" }),
      path.text("/ping", () => "pong", { name: "ping" }),
      path("/old/", Page, { name: "old", trailingSlash: "always" }),
    ]),
  );

await ensureRouterManifest(router.id);

const handler = createRSCHandler({
  router: toInternal(router as Rango<any, any>),
  loadSSRModule: async () => ssrModule,
});

interface BenchCase {
  name: string;
  status: number;
  run: () => Promise<Response>;
}

const get = (path: string) => () => handler(new Request(ORIGIN + path));
const dispatchTo = (path: string) => () => dispatch(router, { request: path });

const handlerCases: BenchCase[] = [
  {
    name: "json, global mw (GET /api/data)",
    status: 200,
    run: get("/api/data"),
  },
  { name: "text, no mw (GET /ping)", status: 200, run: get("/ping") },
  { name: "document (GET /page/1)", status: 200, run: get("/page/1") },
  {
    name: "Flight partial (GET /page/1?_rsc_partial)",
    status: 200,
    run: get("/page/1?_rsc_partial=1"),
  },
  { name: "308 (GET /old)", status: 308, run: get("/old") },
  { name: "404 document (GET /missing)", status: 404, run: get("/missing") },
];

const dispatchCases: BenchCase[] = [
  {
    name: "json, global mw (/api/data)",
    status: 200,
    run: dispatchTo("/api/data"),
  },
  { name: "text, no mw (/ping)", status: 200, run: dispatchTo("/ping") },
  { name: "308 (/old)", status: 308, run: dispatchTo("/old") },
  { name: "404 (/missing)", status: 404, run: dispatchTo("/missing") },
];

// A route answering with the wrong status would time a different path.
for (const { name, status, run } of [...handlerCases, ...dispatchCases]) {
  const response = await run();
  await response.text();
  if (response.status !== status) {
    throw new Error(
      `${name}: expected status ${status}, got ${response.status}`,
    );
  }
}

const options = {
  warmupIterations: WARMUP_REQUESTS,
  iterations: TIMED_REQUESTS,
};

function defineCases(cases: BenchCase[]): void {
  for (const { name, run } of cases) {
    bench(
      name,
      async () => {
        await (await run()).text();
      },
      options,
    );
  }
}

describe("createRSCHandler", () => defineCases(handlerCases));
describe("dispatch", () => defineCases(dispatchCases));
