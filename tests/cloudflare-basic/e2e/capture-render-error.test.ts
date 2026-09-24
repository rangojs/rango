import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// Issue #915: the document cache and the PPR shell capture must not store a
// 200 whose async server component threw after the commit (a Flight error row
// plus an errored Suspense boundary in the HTML). pages/capture-render-error.tsx
// throws on the first renders per ?run= value, then renders; each test uses a
// fresh run so its cache entries are its own. Against the real CFCacheStore on
// workerd, dev and production.

const HTML_HEADERS = { Accept: "text/html" };
const OK_MARKER = 'data-testid="capture-render-error-ok"';
// Lets the errored render's background write (document cache) or capture
// (shell) finish before the next request, so a stored errored entry would be
// served by it.
const SETTLE_MS = 3000;

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
}

test.describe("capture render error (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineCaptureRenderErrorTests(f);
});

test.describe("capture render error (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineCaptureRenderErrorTests(f);
});
