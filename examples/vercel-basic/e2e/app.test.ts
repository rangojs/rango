import { expect, test, type Page } from "@playwright/test";
import {
  devSpec,
  prodSpec,
  waitForHydration,
  expectNoReload,
  expectNoPageError,
  testId,
  type Fixture,
} from "./helper";
import type { SpanNode } from "../src/trace-debug.js";

function flatten(node: SpanNode | null): SpanNode[] {
  return node ? [node, ...node.children.flatMap(flatten)] : [];
}
function find(node: SpanNode | null, name: string): SpanNode | undefined {
  return flatten(node).find((n) => n.name === name);
}

const HTML_HEADERS = { Accept: "text/html" };

async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const response = await request.get(url, { headers: HTML_HEADERS });
    expect(response.status()).toBe(200);
    expect(response.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 20_000 });
}

async function expectInlineActionRoundTrip(page: Page): Promise<void> {
  await expect(testId(page, "ppr-inline-action-page")).toBeVisible();
  const rendered = await testId(
    page,
    "ppr-inline-action-rendered",
  ).textContent();
  const captured = rendered!.replace(/^rendered:/, "");
  expect(captured).toMatch(/^vercel-server-token-/);

  await testId(page, "ppr-inline-action-submit").click();
  await expect(testId(page, "ppr-inline-action-captured")).toHaveText(
    `captured:${captured}`,
  );
  await expect(testId(page, "ppr-inline-action-submitted")).toHaveText(
    "submitted:from-client",
  );
}

function runSpec(f: Fixture): void {
  test("renders the home page", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await expect(testId(page, "home")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Rango on Vercel");
  });

  test("renders the about page", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/about"));
    await expect(testId(page, "about")).toBeVisible();
  });

  test("freezes the /cached timestamp within its TTL", async ({ page }) => {
    const read = async () => {
      const res = await page.request.get(f.url("/cached"), {
        headers: { accept: "text/html" },
      });
      expect(res.status()).toBe(200);
      const m = (await res.text()).match(/datetime="([^"]+)"/i);
      expect(m, "expected a rendered timestamp").toBeTruthy();
      return m![1];
    };
    const first = await read();
    const second = await read();
    // Within the 10s TTL the segment is served from cache, so the timestamp
    // stays frozen across requests (a VercelCacheStore hit in e2e).
    expect(second).toBe(first);
  });

  test("runtime Vercel shell HIT preserves an embedded bound action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const url = f.url("/ppr-inline-action?probe=vercel-ppr-hit");
    await warmToHit(page.request, url);

    const response = await page.goto(url);
    expect(response?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForHydration(page);
    await using __ = await expectNoReload(page);
    await expectInlineActionRoundTrip(page);
  });

  test("partial PPR navigation through Vercel preserves an embedded bound action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await warmToHit(page.request, f.url("/ppr-inline-action"));

    await page.goto(f.url("/"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);
    await testId(page, "nav-ppr-inline-action").click();
    await expect(page).toHaveURL(/\/ppr-inline-action$/);
    await expectInlineActionRoundTrip(page);
  });

  test("client-side navigation works after hydration", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await testId(page, "nav-about").click();
    await expect(page).toHaveURL(/\/about/);
    await expect(testId(page, "about")).toBeVisible();
  });

  test("emits nested rango.* spans via createVercelTracing", async ({
    page,
  }) => {
    // Use the uncached "/" route: a cache hit skips the render phase, so its
    // spans would not fire. Fetch the full SSR document to populate the
    // recorder, then read the captured tree back through /__debug/trace.
    const pageRes = await page.request.get(f.url("/"), {
      headers: { accept: "text/html" },
    });
    expect(pageRes.status()).toBe(200);
    await pageRes.text();

    const traceRes = await page.request.get(f.url("/__debug/trace"));
    expect(traceRes.status()).toBe(200);
    const root = (await traceRes.json()) as SpanNode | null;
    expect(root, "expected a recorded span tree").toBeTruthy();

    // Root request span carries the HTTP attributes the router sets.
    expect(root!.name).toBe("rango.request");
    expect(root!.attributes["http.method"]).toBe("GET");
    expect(root!.attributes["url.path"]).toBe("/");

    // render nests under request and is tagged with the matched route name.
    const render = find(root, "rango.render");
    expect(render, "expected a rango.render span").toBeTruthy();
    expect(render!.attributes["rango.route"]).toBe("home");

    // ssr and the segment handler nest under render.
    expect(find(render, "rango.ssr"), "expected a rango.ssr span").toBeTruthy();
    const handler = find(render, "rango.handler");
    expect(handler, "expected a rango.handler span").toBeTruthy();
    expect(typeof handler!.attributes["rango.handler_id"]).toBe("string");
  });

  test("emits rango.cache.decision instant spans via createOTelSink", async ({
    page,
  }) => {
    // The telemetry slot (createOTelSink) turns each discrete cache decision
    // into an instant span; cache.decision fires on every foreground match with
    // a sink configured, so the uncached "/" route is enough. Fetch the document
    // to drive a match, then read the recorded tree back through /__debug/trace.
    const pageRes = await page.request.get(f.url("/"), {
      headers: { accept: "text/html" },
    });
    expect(pageRes.status()).toBe(200);
    await pageRes.text();

    const traceRes = await page.request.get(f.url("/__debug/trace"));
    expect(traceRes.status()).toBe(200);
    const root = (await traceRes.json()) as SpanNode | null;

    const decision = find(root, "rango.cache.decision");
    expect(
      decision,
      "expected a rango.cache.decision instant span from the telemetry sink",
    ).toBeTruthy();
    expect(typeof decision!.attributes["rango.cache.hit"]).toBe("boolean");
    expect(decision!.attributes["http.route"]).toBe("/");
  });
}

devSpec("vercel-basic", runSpec);
prodSpec("vercel-basic", runSpec);
