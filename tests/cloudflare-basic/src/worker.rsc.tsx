/// <reference types="@cloudflare/workers-types" />
import { router } from "./router.js";
import { prefetchScopeRouter } from "./prefetch-scope-router.js";
import { clientUrlsRouter } from "./client-urls-router.js";
import type { AppBindings } from "./env.js";
import { createRecordingTracer } from "./trace-debug.js";
// Registers a fetchable loader the trace-spans e2e hits via _rsc_loader to
// confirm the fetchable-loader path emits a rango.loader span. Test-only.
// Used (not just imported) below so it is registered in both dev and the
// production bundle (the build cannot tree-shake an observable use).
import { TraceProbeLoader } from "./loaders/trace-probe.js";

// Test-only stash for __trace_debug=<token> tracers, read back (post-
// background-work) via __trace_read=<token>. Module-scoped: per isolate.
const traceStash = new Map<string, ReturnType<typeof createRecordingTracer>>();

// Regression fixture for the `cloudflare:workers` discovery failure.
// The DO class lives in a subdirectory (mirroring real CF projects'
// shape) so the `cloudflare:workers` import is transitive through the
// module graph, not at the worker entry's top level.
export { Counter } from "./workers/durableObject/index.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Skip browser metadata requests
    if (
      url.pathname === "/favicon.ico" ||
      url.pathname.startsWith("/.well-known/")
    ) {
      return new Response(null, { status: 404 });
    }

    if (
      url.pathname === "/__client-urls" ||
      url.pathname.startsWith("/__client-urls/")
    ) {
      return clientUrlsRouter.fetch(request, { env, ctx });
    }

    if (
      url.pathname === "/__prefetch-scope" ||
      url.pathname.startsWith("/__prefetch-scope/")
    ) {
      return prefetchScopeRouter.fetch(request, { env, ctx });
    }

    // Test-only: return the fetchable trace-probe loader's resolved $$id so the
    // trace-spans e2e can build a mode-correct _rsc_loader request (loader ids
    // are raw in dev, hashed in production). Reading $$id here also forces the
    // loader's module to execute, registering it for the _rsc_loader endpoint.
    if (url.searchParams.has("__trace_probe_id")) {
      return new Response((TraceProbeLoader as { $$id: string }).$$id, {
        headers: { "content-type": "text/plain" },
      });
    }
    // Test-only: read back a token-stashed tracer's CURRENT tree. The
    // X-Rango-Trace header below is a snapshot at handoff, so it can never
    // contain spans entered by post-handoff waitUntil work (shell captures,
    // SWR revalidations); this endpoint serializes the same tracer LATER so
    // e2e can assert the rango.background span. Same-isolate only — fine for
    // the single-isolate dev/preview servers the suite runs against.
    const readToken = url.searchParams.get("__trace_read");
    if (readToken !== null) {
      const stashed = traceStash.get(readToken);
      return new Response(stashed ? stashed.serialize() : null, {
        status: stashed ? 200 : 404,
        headers: { "content-type": "text/plain" },
      });
    }
    // Test-only: when ?__trace_debug=1 is present, inject a recording tracer as
    // ctx.tracing (the same hook a tracing-enabled Cloudflare runtime provides),
    // run the request, and expose the captured "rango.*" span tree on the
    // X-Rango-Trace header so e2e can assert span emission + nesting in dev and
    // production. Normal requests have no ctx.tracing and are unaffected.
    // A non-"1" value doubles as a stash token for later __trace_read polls.
    const debugToken = url.searchParams.get("__trace_debug");
    if (debugToken !== null) {
      const tracer = createRecordingTracer();
      if (debugToken && debugToken !== "1") {
        traceStash.set(debugToken, tracer);
        // Bound the stash: evict the oldest entry beyond a small window.
        if (traceStash.size > 8) {
          traceStash.delete(traceStash.keys().next().value!);
        }
      }
      const tracingCtx: ExecutionContext = Object.assign(
        Object.create(Object.getPrototypeOf(ctx)),
        {
          waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
          passThroughOnException: () => ctx.passThroughOnException(),
          props: ctx.props,
          tracing: tracer.tracing,
        },
      );
      const response = await router.fetch(request, { env, ctx: tracingCtx });
      const headers = new Headers(response.headers);
      headers.set("X-Rango-Trace", tracer.serialize());
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // Use router.fetch directly - cache is configured in router with ctx from env
    // Response routes (path.text, urls.json) are handled by the router's short-circuit
    return router.fetch(request, { env, ctx });
  },
} satisfies ExportedHandler<AppBindings>;
