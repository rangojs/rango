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
 *   client manifest used here — fine for snapshotting the SHAPE of the payload,
 *   but the client reference cannot be executed/hydrated. The interactive DOM
 *   render (`renderServer`) is deferred (see module TODO at bottom of report).
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
import type { RscPayload } from "../rsc/types.js";
import type { ResolvedSegment } from "../types.js";

/**
 * Options for {@link renderToFlightString}.
 */
export interface RenderToFlightStringOptions {
  /** Request URL. Defaults to `http://localhost/`. */
  url?: string;
  /** Request headers (e.g. Cookie) visible to the server tree. */
  headers?: HeadersInit;
  /** Env / bindings exposed as `ctx.env`. Defaults to `{}`. */
  env?: unknown;
  /** Route params exposed via `ctx.params` and loader contexts. */
  params?: Record<string, string>;
  /** Matched route name (drives `ctx.routeName` and scoped reverse). */
  routeName?: string;
}

const DEFAULT_URL = "http://localhost/";

/**
 * Wrap a single element in the minimal ResolvedSegment + RscPayload shape that
 * mirrors Rango's wire format, so the serialized output matches what a real
 * route segment would emit.
 */
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
  // Server-only trees: empty client manifest. A client reference would emit an
  // unresolvable `I` row here; use renderServerTree (flight-tree.ts) when the
  // tree has client boundaries you want to inspect.
  return serializeToFlightString(element, opts, {});
}

/**
 * Shared serialize core: set up a request context, wrap the element as a Rango
 * payload, and serialize it with the given client-reference manifest. Used by
 * {@link renderToFlightString} (empty manifest) and renderServerTree (a manifest
 * that resolves every registered client reference).
 *
 * Must run under the `react-server` export condition (see module header).
 */
export async function serializeToFlightString(
  element: ReactNode,
  opts: RenderToFlightStringOptions,
  clientManifest: unknown,
): Promise<string> {
  const url = new URL(opts.url ?? DEFAULT_URL);
  const request = new Request(url, { headers: opts.headers });
  const ctx = createRequestContext({
    env: opts.env ?? {},
    request,
    url,
    variables: {},
  });

  const payload = wrapAsPayload(element, url.pathname);

  return runWithRequestContext(ctx, async () => {
    setRequestContextParams(opts.params ?? {}, opts.routeName);
    // Capture (do NOT rethrow) the first render error. The serializer calls
    // onError from its own scheduled work; throwing there escapes as an
    // unhandled rejection AND leaves the stream un-closed, so the drain below
    // would hang until the test times out. Production's onError returns void
    // (rsc-rendering.ts) so the stream completes with an error row. We mirror
    // that — let the stream finish — then surface the error as a clean
    // rejection after draining, so `await expect(...).rejects.toThrow()` works.
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
    // Drain inside the context so async components see ctx during streaming.
    const text = await new Response(stream).text();
    if (didError) throw renderError;
    return text;
  });
}

// Volatile leading reference row: `:N<timestamp>` (dev debug-info anchor).
const REFERENCE_ROW_RE = /^:N[\d.]+\n/;
// Absolute file:// paths embedded in dev STACK rows. The serializer emits stack
// frames as `["Component","file:///abs/path.tsx",<line>,<col>,...]`, so the
// path is a quoted JSON string immediately followed by `",<line>,<col>`. The
// lookahead scopes the scrub to exactly that frame shape, leaving a legitimate
// `file://` href in RENDERED content (e.g. `{"href":"file:///x"}`) untouched.
const FILE_URL_RE = /file:\/\/[^"\\]+(?=",\d+,\d+)/g;

/**
 * Scrub volatile bits from a Flight string so snapshots are stable across runs
 * and machines:
 * - the leading `:N<timestamp>` reference row (dev only),
 * - absolute `file://...` paths inside dev stack rows.
 *
 * Under NODE_ENV=production these rows are already absent; normalize is a
 * no-op safety net there. In dev mode it removes the machine/clock-specific
 * noise while leaving the rendered tree intact.
 */
export function normalizeFlight(flight: string): string {
  return flight
    .replace(REFERENCE_ROW_RE, "")
    .replace(FILE_URL_RE, "file://<path>");
}

/**
 * Smoke check that the vendored serializer subpath still resolves and exposes
 * `renderToReadableStream`. The vendored path is private to plugin-rsc; a minor
 * bump could relocate it. Call this in a test to fail loudly with a clear
 * message instead of an opaque import error.
 */
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
