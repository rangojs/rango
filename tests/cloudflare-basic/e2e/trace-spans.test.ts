import { expect, test, type APIResponse } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * End-to-end coverage for Cloudflare custom spans (createCloudflareTracing).
 *
 * The router is wired with `tracing: createCloudflareTracing()` (src/router.tsx).
 * Real Cloudflare spans only surface in the Workers trace waterfall / OTel
 * export, which an e2e cannot read — so the worker entry injects a recording
 * tracer as `ctx.tracing` when `?__trace_debug=1` is present and serializes the
 * captured "rango.*" span tree onto the X-Rango-Trace header (see
 * src/trace-debug.ts and src/worker.rsc.tsx). The router code under test is
 * identical to production; only the tracer stands in for the platform's.
 *
 * This runs in BOTH dev and production so the wrapping, the runner's
 * executionContext.tracing read, and async-context nesting are all verified in
 * a real workerd runtime in each mode.
 */

interface SpanNode {
  name: string;
  attributes: Record<string, string | number | boolean>;
  children: SpanNode[];
}

function decodeTraceHeader(header: string | null | undefined): SpanNode[] {
  expect(
    header,
    "X-Rango-Trace missing — is tracing wired on the router and __trace_debug handled in the worker?",
  ).toBeTruthy();
  const json = decodeURIComponent(escape(atob(header!)));
  return JSON.parse(json) as SpanNode[];
}

function decodeTrace(res: APIResponse): SpanNode[] {
  return decodeTraceHeader(res.headers()["x-rango-trace"]);
}

function flatten(nodes: SpanNode[]): SpanNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

function findNode(nodes: SpanNode[], name: string): SpanNode | undefined {
  return flatten(nodes).find((n) => n.name === name);
}

/** True when `descendant` is named `name` anywhere inside `root`'s subtree. */
function hasDescendant(root: SpanNode, name: string): boolean {
  return flatten(root.children).some((n) => n.name === name);
}

function runTraceSpec(f: Fixture): void {
  test("emits nested rango.* spans for a full-page request", async ({
    page,
  }) => {
    // /blog renders SSR and has a layout-level loader (BlogSidebarLoader), so
    // the request/render/ssr/loader phases all run. Accept: text/html forces
    // the full-page SSR branch (a bare fetch would take the RSC-payload path).
    // __no_cache disables the cache store for this request, so the document
    // cache misses (render + ssr run) AND the cached BlogSidebarLoader executes
    // fresh rather than hitting the loader cache. The loader phase = execution,
    // so without this a warm loader-cache HIT (cb= only busts the document
    // cache, not the loader cache) would emit no rango.loader span.
    const res = await page.request.get(
      f.url(`/blog?__trace_debug=1&__no_cache=1`),
      { headers: { accept: "text/html" } },
    );
    expect(res.status()).toBe(200);

    const roots = decodeTrace(res);

    // Exactly one root span: the request.
    expect(roots).toHaveLength(1);
    const request = roots[0];
    expect(request.name).toBe("rango.request");
    expect(request.attributes["http.method"]).toBe("GET");
    expect(request.attributes["url.path"]).toBe("/blog");

    // render nests under the request (directly or via middleware).
    const render = findNode(roots, "rango.render");
    expect(render, "expected a rango.render span").toBeTruthy();
    expect(hasDescendant(request, "rango.render")).toBe(true);

    // the render span is tagged with the matched route name (resolved after match).
    expect(render!.attributes["rango.route"]).toBe("blog");

    // ssr nests under render.
    expect(hasDescendant(render!, "rango.ssr")).toBe(true);

    // the blog sidebar loader produces a rango.loader span with its loader id.
    const loader = findNode(roots, "rango.loader");
    expect(loader, "expected a rango.loader span").toBeTruthy();
    expect(typeof loader!.attributes["rango.loader_id"]).toBe("string");

    // the route/layout handler executions produce rango.handler spans (the
    // dominant per-segment work), nested under render and tagged with the
    // handler id — mirroring the handler:<id> perf rows.
    const handler = findNode(roots, "rango.handler");
    expect(handler, "expected a rango.handler span").toBeTruthy();
    expect(typeof handler!.attributes["rango.handler_id"]).toBe("string");
    expect(hasDescendant(render!, "rango.handler")).toBe(true);

    // global document-cache middleware wraps the request.
    const middleware = findNode(roots, "rango.middleware");
    expect(middleware, "expected a rango.middleware span").toBeTruthy();
    expect(hasDescendant(request, "rango.middleware")).toBe(true);

    // Exactly one rango.response span — the final-response/host-handoff
    // marker — as a DIRECT child of rango.request (it opens after downstream
    // middleware/render work returned, so it never nests under them), tagged
    // with the response actually handed to the host.
    const responses = flatten(roots).filter((n) => n.name === "rango.response");
    expect(responses).toHaveLength(1);
    expect(
      request.children.some((n) => n.name === "rango.response"),
      "rango.response must be a direct child of rango.request",
    ).toBe(true);
    expect(responses[0].attributes["http.response.status_code"]).toBe(200);
    expect(responses[0].attributes["rango.response.mode"]).toBe("full-render");
    expect(responses[0].attributes["rango.response.body_kind"]).toBe("stream");
  });

  test("emits a rango.loader span for a fetchable _rsc_loader request", async ({
    page,
  }) => {
    // useFetchLoader().load() / client loader fetches hit the standalone
    // _rsc_loader endpoint, which executes the loader directly (not via the
    // render-time resolveLoaderData path). It must still emit rango.loader.
    // Loader ids are raw in dev but hashed in production, so ask the worker for
    // the fetchable TraceProbeLoader's resolved id rather than hardcoding it.
    const idRes = await page.request.get(f.url("/?__trace_probe_id=1"));
    expect(idRes.status()).toBe(200);
    const loaderId = (await idRes.text()).trim();
    expect(loaderId).toContain("TraceProbeLoader");

    const res = await page.request.get(
      f.url(`/?_rsc_loader=${encodeURIComponent(loaderId)}&__trace_debug=1`),
    );
    expect(res.status()).toBe(200);

    const roots = decodeTrace(res);
    const request = findNode(roots, "rango.request");
    expect(request, "expected a rango.request span").toBeTruthy();

    const loader = findNode(roots, "rango.loader");
    expect(
      loader,
      "expected a rango.loader span for the fetchable loader",
    ).toBeTruthy();
    expect(loader!.attributes["rango.loader_id"]).toContain("TraceProbeLoader");
    expect(hasDescendant(request!, "rango.loader")).toBe(true);

    // A standalone loader request renders nothing: render/ssr/handler are
    // intentionally absent (a correct trace, not dropped spans) — while the
    // rango.response handoff marker IS present, tagged with the loader mode.
    // This is the trace shape that motivated the marker: without it, a
    // no-render trace looks truncated at the request boundary.
    expect(findNode(roots, "rango.render")).toBeUndefined();
    expect(findNode(roots, "rango.ssr")).toBeUndefined();
    expect(findNode(roots, "rango.handler")).toBeUndefined();
    const response = findNode(roots, "rango.response");
    expect(response, "expected a rango.response span").toBeTruthy();
    expect(
      request!.children.some((n) => n.name === "rango.response"),
      "rango.response must be a direct child of rango.request",
    ).toBe(true);
    expect(response!.attributes["rango.response.mode"]).toBe("loader");
    expect(response!.attributes["http.response.status_code"]).toBe(200);
  });

  test("records the response handoff marker before the delayed loader content streams", async () => {
    // page.request buffers the whole body, so stream with Node fetch instead.
    // /ppr-shell carries its ~400ms price loader promise into the component
    // behind loading(), so the shell (with the fallback) flushes first and the
    // live price streams later in the same body (/blog would NOT do: its
    // sidebar handler awaits the loader, blocking response construction).
    // __no_cache keeps this a fresh render (no shell-cache HIT interference).
    // Dev only: warm the route's modules first — on a cold dev server the
    // on-demand compile exceeds the 400ms loader delay, so the whole body
    // coalesces into one flush and nothing streams. The shared dev-warmup
    // setup project already warms /ppr-shell (PPR_WARMUP_ROUTES), but local
    // `--no-deps` subset runs skip it; this keeps the test self-sufficient.
    // The loader delay is paid per request, so the warmed request streams.
    if (f.mode === "dev") {
      await fetch(f.url(`/ppr-shell?__no_cache=1`), {
        headers: { accept: "text/html" },
      }).then((warm) => warm.body?.cancel());
    }

    const res = await fetch(f.url(`/ppr-shell?__trace_debug=1&__no_cache=1`), {
      headers: { accept: "text/html" },
    });
    expect(res.status).toBe(200);

    // The X-Rango-Trace header is serialized at handoff (right after
    // router.fetch resolves) — asserting on it BEFORE draining the body proves
    // the rango.response marker exists while the price is still streaming.
    const roots = decodeTraceHeader(res.headers.get("x-rango-trace"));
    const response = findNode(roots, "rango.response");
    expect(
      response,
      "expected rango.response recorded at handoff, before body drain",
    ).toBeTruthy();
    expect(response!.attributes["rango.response.body_kind"]).toBe("stream");
    expect(response!.attributes["http.response.status_code"]).toBe(200);

    // Stream the body once: the first flush containing the Suspense fallback
    // must NOT already contain the live price (that would mean nothing
    // streamed); the delayed loader content arrives later on the same body.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let sawFallbackFirst = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (!sawFallbackFirst && html.includes("ppr-price-fallback")) {
        sawFallbackFirst = true;
        expect(
          html,
          "fallback flushed with the price already inlined",
        ).not.toContain("Live price:");
      }
    }
    expect(sawFallbackFirst, "stream ended before the shell flushed").toBe(
      true,
    );
    expect(html).toContain("Live price:");
  });

  test("does not emit spans without __trace_debug", async ({ page }) => {
    const res = await page.request.get(f.url("/blog"));
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-trace"]).toBeUndefined();
  });
}

test.describe("cloudflare custom spans (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runTraceSpec(f);
});

test.describe("cloudflare custom spans (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runTraceSpec(f);
});
