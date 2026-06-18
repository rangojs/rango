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
  /** Settle order: lower ended first. -1 = still open at serialize time. */
  endOrder: number;
}

function decodeTrace(res: APIResponse): SpanNode[] {
  const header = res.headers()["x-rango-trace"];
  expect(
    header,
    "X-Rango-Trace missing — is tracing wired on the router and __trace_debug handled in the worker?",
  ).toBeTruthy();
  const json = decodeURIComponent(escape(atob(header)));
  return JSON.parse(json) as SpanNode[];
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

    // Drain-bound validity: render/ssr spans now stay open until the response
    // body drains, so the loader (which settles when its data resolves) ends
    // BEFORE its render parent. Under the old construction-bound spans render
    // ended at stream construction and the loader dangled past it. Both must be
    // settled (endOrder !== -1, since the worker drains the body before
    // serializing) and loader must end first.
    expect(
      loader!.endOrder,
      "loader span should have settled",
    ).toBeGreaterThanOrEqual(0);
    expect(
      render!.endOrder,
      "render span should have settled",
    ).toBeGreaterThanOrEqual(0);
    expect(
      loader!.endOrder,
      "loader must end before its drain-bound render parent (valid tree)",
    ).toBeLessThan(render!.endOrder);

    // global document-cache middleware wraps the request.
    const middleware = findNode(roots, "rango.middleware");
    expect(middleware, "expected a rango.middleware span").toBeTruthy();
    expect(hasDescendant(request, "rango.middleware")).toBe(true);
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
