import { test, expect, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";

// Pins the /app group the bench harness loads against (bench/scenarios.ts):
// layout + parallel loaders SSR, middleware chain headers, cache() segment
// behavior, the Flight (client-navigation) request shape, and the PE action
// POST. If any of these silently regress, the corresponding bench scenario
// measures garbage — the harness validation and this suite fail together.
//
// Direct `vite` commands (not `pnpm dev/preview`) so the suite runs locally
// without tripping the pnpm verifyDepsBeforeRun -> lefthook install hook.

async function expectAppLoadSurface(
  request: APIRequestContext,
  url: (u: string) => string,
) {
  // Dashboard: nested layout + 3 parallel loaders, consumed by client
  // components — all three must be present in the SSR'd document.
  const dash = await request.get(url("/app/dashboard/main"), {
    headers: { accept: "text/html" },
  });
  expect(dash.status()).toBe(200);
  const dashHtml = await dash.text();
  expect(dashHtml).toContain('data-testid="shell-nav"');
  expect(dashHtml).toContain('data-testid="stats"');
  expect(dashHtml).toContain('data-testid="activity"');

  // Middleware chain: route middleware sets X-Render-Ms, global middleware
  // sets security headers on the way out.
  const headers = dash.headers();
  expect(headers["x-render-ms"]).toBeTruthy();
  expect(headers["x-frame-options"]).toBe("DENY");

  // Flight request: the exact wire shape the client router sends on
  // navigation (see browser/navigation-client.ts fetchPartial).
  const flight = await request.get(
    url("/site/en/flat/1?_rsc_partial=true&_rsc_segments="),
    { headers: { "X-RSC-Router-Client-Path": "/" } },
  );
  expect(flight.status()).toBe(200);
  expect(flight.headers()["content-type"]).toContain("text/x-component");

  // PE action POST: scrape the build-dependent $ACTION_ID_* field from the
  // rendered form, post it form-encoded, expect a full re-render.
  const form = await request.get(url("/app/feedback"), {
    headers: { accept: "text/html" },
  });
  expect(form.status()).toBe(200);
  const formHtml = await form.text();
  const actionField = formHtml.match(/name="(\$ACTION_ID_[^"]+)"/);
  expect(actionField, "PE form must render an $ACTION_ID field").toBeTruthy();

  const post = await request.post(url("/app/feedback"), {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
    },
    data: new URLSearchParams({
      [actionField![1]!]: "",
      message: "e2e",
    }).toString(),
  });
  expect(post.status()).toBe(200);
  expect(await post.text()).toContain('data-testid="feedback-form"');
}

async function expectCachedSegmentServesStoredRender(
  request: APIRequestContext,
  url: (u: string) => string,
  bucket: string,
) {
  const read = async () => {
    const res = await request.get(url(`/app/cached/${bucket}`), {
      headers: { accept: "text/html" },
    });
    expect(res.status()).toBe(200);
    const html = await res.text();
    const m = html.match(/data-testid="cached-rendered-at">(\d+)</);
    expect(m, "cached page must render its timestamp").toBeTruthy();
    return m![1]!;
  };

  const first = await read();
  const second = await read();
  // A cache hit serves the STORED render: same timestamp both times.
  expect(second).toBe(first);
}

test.describe("app load surface (dev)", () => {
  const f = useFixture({ root: ".", command: "node_modules/.bin/vite dev" });

  test("dashboard loaders, middleware headers, flight request, action post", async ({
    request,
  }) => {
    await expectAppLoadSurface(request, f.url);
  });

  test("cache() segment serves the stored render on repeat requests", async ({
    request,
  }) => {
    await expectCachedSegmentServesStoredRender(request, f.url, "e2e-dev");
  });
});

test.describe("app load surface (production)", () => {
  const f = useFixture({
    root: ".",
    command: "node_modules/.bin/vite preview",
  });

  test("dashboard loaders, middleware headers, flight request, action post", async ({
    request,
  }) => {
    await expectAppLoadSurface(request, f.url);
  });

  test("cache() segment serves the stored render on repeat requests", async ({
    request,
  }) => {
    await expectCachedSegmentServesStoredRender(request, f.url, "e2e-prod");
  });
});
