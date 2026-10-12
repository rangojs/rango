/**
 * Per-request object cost (#1109): creating the request context, a middleware
 * ctx and a handle store, and reading a request-context field. All three keep
 * V8 fast properties (context-fast-properties.test.ts); a dictionary-mode
 * object costs more to build and a hash lookup on every read.
 *
 *   ./node_modules/.bin/vitest bench --run src/server/__tests__/context-creation.bench.ts
 */
import { bench, describe } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
} from "../request-context.js";
import { createHandleStore } from "../handle-store.js";
import { createMiddlewareContext } from "../../router/middleware.js";

const url = new URL("https://example.com/p?q=1");
const request = new Request(url, { headers: { cookie: "a=1" } });
const themeConfig = {
  storageKey: "theme",
  themes: ["light", "dark"],
  defaultTheme: "light",
  enableSystem: true,
  attribute: "class",
  value: {},
} as any;
const makeRequestContext = () =>
  createRequestContext({ env: {}, request, url, variables: {}, themeConfig });
const reqCtx = makeRequestContext();
const holder = { response: new Response(null) };

let sink: unknown;

describe("per-request objects", () => {
  bench("createRequestContext", () => {
    sink = makeRequestContext();
  });

  bench("createMiddlewareContext", () => {
    sink = runWithRequestContext(reqCtx, () =>
      createMiddlewareContext(request, {}, {}, {}, holder),
    );
  });

  bench("createHandleStore", () => {
    sink = createHandleStore();
  });

  bench("request context: 1000 field reads", () => {
    let n = 0;
    for (let i = 0; i < 250; i++) {
      if (reqCtx.pathname) n++;
      if (reqCtx.method) n++;
      if (reqCtx.request) n++;
      if (reqCtx.env) n++;
    }
    sink = n;
  });
});

void sink;
