import { expect, test } from "@playwright/test";
import {
  devSpec,
  prodSpec,
  waitForHydration,
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
    // stays frozen across requests (an in-process MemorySegmentCacheStore hit).
    expect(second).toBe(first);
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
}

devSpec("vercel-basic", runSpec);
prodSpec("vercel-basic", runSpec);
