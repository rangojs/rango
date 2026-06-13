/// <reference path="./flight-runtime.d.ts" />
/**
 * renderToFlightString — REAL React Server Component (Flight) rendering for
 * unit tests of @rangojs/router consumer apps.
 *
 * This module renders a server component tree to its Flight wire string using
 * the same react-server-dom serializer the router uses at runtime. It runs in
 * plain node (no Vite, no browser), but ONLY under the `react-server` export
 * condition. The serializer is the VENDORED build shipped with
 * @vitejs/plugin-rsc — the public `@vitejs/plugin-rsc/rsc` entry top-level
 * imports Vite virtual modules and is not usable outside a Vite build.
 *
 * Run the example/tests for this module via the dedicated rsc vitest project
 * (vitest.rsc.config.ts), which forces `--conditions=react-server` on the
 * worker. The main vitest project must NOT use that condition (it would flip
 * React to the no-hooks server build and break the ~50 tests that mock
 * @vitejs/plugin-rsc/rsc).
 *
 * Scope / limitations (v1):
 * - Server-only / leaf trees. A tree containing a CLIENT component emits an
 *   `I[...]` import row whose module id will not resolve against the empty `{}`
 *   client manifest used here — fine for snapshotting the SHAPE of the payload.
 *   To inspect a client boundary's deserialized props instead, use
 *   `renderServerTree` (flight-tree.ts). Interactive hydration stays at the e2e tier.
 * - The vendored subpath is a private plugin-rsc path; a minor bump could move
 *   it. `assertFlightRuntimeAvailable()` provides a smoke check.
 * - For stable snapshots, run under NODE_ENV=production: the production
 *   serializer drops the dev-only debug-info rows (the `N<timestamp>` reference
 *   row, the per-component `stack`/`env` rows, and `D{...}` timing rows),
 *   leaving just the rendered tree row(s).
 */

import type { ReactNode } from "react";
// Vendored react-server-dom serializer. Resolves via plugin-rsc's
// `"./*": "./dist/*.js"` export to
// dist/vendor/react-server-dom/server.edge.js. Only loadable under the
// `react-server` export condition.
import * as RSDServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import {
  createRequestContext,
  runWithRequestContext,
  setRequestContextParams,
} from "../server/request-context.js";
import { seedVariables, type VarsInit } from "./internal/seed-vars.js";
import { normalizeFlight } from "./flight-normalize.js";
import type { RscPayload } from "../rsc/types.js";
import type { ResolvedSegment } from "../types.js";

// Re-export from the serializer-free module so this entry's public surface is
// unchanged while flight-matchers can import normalizeFlight without pulling in
// the vendored serializer (which throws outside the react-server condition).
export { normalizeFlight };

/**
 * Options for {@link renderToFlightString}.
 */
export interface RenderToFlightStringOptions {
  /**
   * The request the render runs under: a `Request`, or a URL string (absolute or
   * path). Defaults to `http://localhost/`. A server component reading
   * `getRequestContext()` sees this request's url/cookies. When a `Request` is
   * passed, its headers are used and `headers` below is ignored.
   */
  request?: Request | string;
  /** Request headers (e.g. Cookie) visible to the server tree (when `request` is a string). */
  headers?: HeadersInit;
  /** Env / bindings exposed as `ctx.env`. Defaults to `{}`. */
  env?: unknown;
  /** Route params exposed via `ctx.params` and loader contexts. */
  params?: Record<string, string>;
  /** Matched route name (drives `ctx.routeName` and scoped reverse). */
  routeName?: string;
  /**
   * Context variables visible to the rendered tree via `ctx.get(...)` — as a
   * prior middleware would have set them. Seeds the SAME way the handler-test
   * primitives (`runInRequestContext`/`runLoader`) do, so a server component
   * that reads `getRequestContext().get(MyVar)` during render is testable.
   * Object form (`{ user }`) or `[key, value]` tuples (`[[userVar, u]]`).
   */
  vars?: VarsInit;
}

const DEFAULT_URL = "http://localhost/";

export function assertNoLegacyUrlOption(opts: object, fnName: string): void {
  if ("url" in opts) {
    throw new Error(
      `${fnName}: the \`url\` option was renamed to \`request\`. Pass ` +
        `{ request: "<url-or-path>" } (or a Request) instead of { url }. ` +
        `The legacy \`url\` key is ignored, so the render would silently use ` +
        `the default origin.`,
    );
  }
}

function wrapAsPayload(element: ReactNode, pathname: string): RscPayload {
  const segment: ResolvedSegment = {
    id: "test",
    namespace: "",
    type: "route",
    index: 0,
    component: element,
  };
  return {
    metadata: {
      pathname,
      segments: [segment],
      version: "test",
    },
  };
}

/**
 * Render a server component (or any ReactNode) to its Flight wire string.
 *
 * The element is wrapped in a minimal Rango segment + payload, then serialized
 * with the vendored react-server-dom server. A request context is active for
 * the duration of the render (drained INSIDE runWithRequestContext) so async
 * server components can call getRequestContext(), read params, cookies, etc.
 *
 * Must run under the `react-server` export condition (see module header).
 */
export async function renderToFlightString(
  element: ReactNode,
  opts: RenderToFlightStringOptions = {},
): Promise<string> {
  assertNoLegacyUrlOption(opts, "renderToFlightString");
  return serializeToFlightString(element, opts, {});
}

export async function serializeToFlightString(
  element: ReactNode,
  opts: RenderToFlightStringOptions,
  clientManifest: unknown,
): Promise<string> {
  const request =
    opts.request instanceof Request
      ? opts.request
      : new Request(new URL(opts.request ?? DEFAULT_URL, DEFAULT_URL), {
          headers: opts.headers,
        });
  const url = new URL(request.url);
  const ctx = createRequestContext({
    env: opts.env ?? {},
    request,
    url,
    variables: seedVariables({}, opts.vars),
  });

  return runWithRequestContext(ctx, () => {
    setRequestContextParams(opts.params ?? {}, opts.routeName);
    return serializeNodeToFlight(element, clientManifest, url.pathname);
  });
}

export async function serializeNodeToFlight(
  node: ReactNode,
  clientManifest: unknown,
  pathname: string,
): Promise<string> {
  const payload = wrapAsPayload(node, pathname);
  let renderError: unknown;
  let didError = false;
  const stream = RSDServer.renderToReadableStream(payload, clientManifest, {
    onError(error: unknown) {
      if (!didError) {
        didError = true;
        renderError = error;
      }
    },
  });
  const text = await new Response(stream).text();
  if (didError) throw renderError;
  return text;
}

export function assertFlightRuntimeAvailable(): void {
  if (typeof RSDServer.renderToReadableStream !== "function") {
    throw new Error(
      "Vendored react-server-dom serializer not available: " +
        "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge did not export " +
        "renderToReadableStream. The private vendored subpath may have moved in " +
        "a plugin-rsc upgrade.",
    );
  }
}
