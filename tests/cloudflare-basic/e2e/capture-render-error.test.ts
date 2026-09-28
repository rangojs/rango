import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// Issue #915: the document cache and the PPR shell capture must not store a
// 200 whose async server component threw after the commit (a Flight error row
// plus an errored Suspense boundary in the HTML). pages/capture-render-error.tsx
// throws on the first renders per ?run= value, then renders; each test uses a
// fresh run so its cache entries are its own. Against the real CFCacheStore on
// workerd, dev and production. The route cache (#909) and a bake-lane value
// that fails only on the snapshot encode (#927) follow the same shape.

const HTML_HEADERS = { Accept: "text/html" };
const OK_MARKER = 'data-testid="capture-render-error-ok"';
// Lets the errored render's background write (document cache, route cache) or
// capture (shell) finish before the next request, so a stored errored entry
// would be served by it.
const SETTLE_MS = 3000;
const HANDLER_RUN = /data-testid="route-cache-handler-run">(\d+)</;

function runId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function firstHit(
  get: () => ReturnType<APIRequestContext["get"]>,
  header: string,
): Promise<string> {
  let html = "";
  await expect
    .poll(
      async () => {
        const res = await get();
        expect(res.status()).toBe(200);
        if (res.headers()[header] !== "HIT") return false;
        html = await res.text();
        return true;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return html;
}

function defineCaptureRenderErrorTests(f: Fixture) {
  test("document cache: an errored render is not stored; the next render is", async ({
    request,
  }) => {
    const url = f.url(`/document-cache-render-error?run=${runId()}`);
    const get = () => request.get(url, { headers: HTML_HEADERS });

    const first = await get();
    expect(first.status()).toBe(200);
    expect(first.headers()["x-document-cache-status"]).toBe("MISS");
    expect(await first.text()).not.toContain(OK_MARKER);

    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const hit = await firstHit(get, "x-document-cache-status");
    expect(hit).toContain(OK_MARKER);
  });

  test("ppr: a shell whose component threw during capture is not stored; a clean capture is", async ({
    request,
  }) => {
    const url = f.url(`/ppr-render-error?run=${runId()}`);
    const get = () => request.get(url, { headers: HTML_HEADERS });

    const first = await get();
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-shell"]).toBe("MISS");
    expect(await first.text()).not.toContain(OK_MARKER);

    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const hit = await firstHit(get, "x-rango-shell");
    const preludeEnd = hit.indexOf("</html>");
    expect(preludeEnd).toBeGreaterThan(-1);
    expect(hit.slice(0, preludeEnd)).toContain(OK_MARKER);
  });

  // Issue #909: pages/capture-render-error.tsx RouteCacheRenderErrorPage.
  test("route cache: a write whose async child threw is not stored; the next request renders", async ({
    request,
  }) => {
    const url = f.url(`/route-cache-render-error?run=${runId()}`);
    const load = async () => {
      const res = await request.get(url, { headers: HTML_HEADERS });
      expect(res.status()).toBe(200);
      const html = await res.text();
      return {
        run: html.match(HANDLER_RUN)?.[1],
        ok: html.includes(OK_MARKER),
      };
    };

    expect(await load()).toEqual({ run: "1", ok: false });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // Not a HIT of the errored entry: the handler runs again and Reviews renders.
    expect(await load()).toEqual({ run: "2", ok: true });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // The clean run is stored: a HIT keeps its handler run.
    expect(await load()).toEqual({ run: "2", ok: true });
  });

  // Issue #927: loaders/ppr-shell.ts PprFlightErrorLoader.
  test("ppr: a shell whose bake-lane value failed on the snapshot encode is not stored; a clean capture is", async ({
    request,
  }) => {
    const run = runId();
    const url = f.url(`/ppr-flight-error?run=${run}`);
    const get = () => request.get(url, { headers: HTML_HEADERS });

    const first = await get();
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-shell"]).toBe("MISS");

    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const next = await get();
    expect(next.headers()["x-rango-shell"]).toBe("MISS");
    // The capture's value was iterated exactly twice (render, then snapshot
    // encode), so the pass-2 failure hit the snapshot encode.
    const passes = await request.get(
      f.url(`/ppr-flight-error-passes?run=${run}`),
    );
    expect(await passes.json()).toEqual({ passes: 2 });
    await firstHit(get, "x-rango-shell");
  });
}

test.describe("capture render error (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineCaptureRenderErrorTests(f);
});

test.describe("capture render error (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineCaptureRenderErrorTests(f);
});
