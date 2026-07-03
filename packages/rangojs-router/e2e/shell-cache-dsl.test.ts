import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Deliverable 4(c): PPR shell caching attached via the urls() `middleware()` DSL
// (route middleware) instead of `router.use()` (global). The middleware lives in
// shellCacheDslPatterns (test-app/src/urls/shell-cache.tsx) and covers ONLY the
// NEW /shell-cache-dsl subtree; the existing /shell-cache/* routes (router.use
// attachment) are untouched. This suite pins that the MISS -> HIT flip and the HIT
// composition (frozen shell prelude before the live loader hole) behave IDENTICALLY
// under DSL attachment. Route middleware wraps the render pass; on a GET it arms the
// capture descriptor exactly like the global attachment, so the render layer
// schedules the same background capture. Runs in BOTH dev and the built preview
// server. See docs/design/ppr-shell-resume.md ("DSL middleware() attachment").

const LOADER_DELAY_MS = 400;
const HTML_HEADERS = { Accept: "text/html" };

async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 10000 });
}

async function measureFirstChunk(
  url: string,
): Promise<{ ttfb: number; firstChunk: string; html: string }> {
  const start = Date.now();
  const res = await fetch(url, { headers: { Accept: "text/html" } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const ttfb = Date.now() - start;
  const firstChunk = first.value
    ? decoder.decode(first.value, { stream: true })
    : "";
  let html = firstChunk;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) html += decoder.decode(value, { stream: true });
  }
  html += decoder.decode();
  return { ttfb, firstChunk, html };
}

function guardHydrationErrors(page: Page) {
  const errors: string[] = [];
  const isHydrationError = (text: string) =>
    text.includes("hydration") ||
    text.includes("Hydration") ||
    text.includes("Minified React error");
  const onConsole = (msg: import("@playwright/test").ConsoleMessage) => {
    if (msg.type() === "error" && isHydrationError(msg.text())) {
      errors.push(msg.text());
    }
  };
  const onPageError = (err: Error) => {
    if (isHydrationError(err.message)) errors.push(err.message);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return {
    [Symbol.dispose]: () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      expect(errors, "no hydration / Minified React errors").toEqual([]);
    },
  };
}

function runDslSpec(f: Fixture): void {
  test("DSL-attached route engages and tags x-rango-shell: MISS on the first GET", async ({
    request,
  }) => {
    const res = await request.get(f.url("/shell-cache-dsl?probe=miss"), {
      headers: HTML_HEADERS,
    });
    expect(res.status()).toBe(200);
    // The middleware engaged even though it was attached via middleware(), not
    // router.use() — proving DSL attachment arms the capture path.
    expect(res.headers()["x-rango-shell"]).toBe("MISS");
    const html = await res.text();
    expect(html).toContain("Shell Cache DSL Demo");
    expect(html).toContain("Live price:");
  });

  test("DSL-attached route flips MISS -> HIT identically to router.use()", async ({
    request,
  }) => {
    const url = f.url("/shell-cache-dsl?probe=hit");
    const res1 = await request.get(url, { headers: HTML_HEADERS });
    expect(res1.headers()["x-rango-shell"]).toBe("MISS");
    await warmToHit(request, url);
  });

  test("DSL-attached HIT composes the cached shell before the live hole", async ({
    request,
  }) => {
    const url = f.url("/shell-cache-dsl?probe=compose");
    await warmToHit(request, url);

    const { ttfb, firstChunk, html } = await measureFirstChunk(url);

    // The frozen shell (static DSL text + counter markup + the loading() fallback)
    // is in the first flushed bytes; the live price is NOT.
    expect(firstChunk).toContain("Shell Cache DSL Demo");
    expect(firstChunk).toContain("Loading price...");
    expect(firstChunk).not.toContain("Live price:");

    // The live loader content + React's $RC boundary stitch arrive later in the
    // SAME response body.
    expect(html).toContain("Live price:");
    expect(html).toContain("$RC");

    // First byte (the cached prelude) does not wait on the ~400ms live loader.
    expect(ttfb).toBeLessThan(LOADER_DELAY_MS);
  });

  test("DSL-attached HIT page hydrates with zero errors and stays interactive", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const url = f.url("/shell-cache-dsl?probe=browserhit");
    await warmToHit(page.request, url);

    await page.goto(url);
    await waitForHydration(page);

    await expect(testId(page, "shell-dsl-header")).toHaveText(
      "Shell Cache DSL Demo",
    );
    await expect(testId(page, "shell-price")).toContainText("Live price:");

    // The shell's interactive island hydrated: the counter responds to clicks.
    const counter = testId(page, "shell-counter");
    await expect(counter).toHaveText("count: 0");
    await counter.click();
    await expect(counter).toHaveText("count: 1");
  });
}

test.describe("shell-cache DSL attachment (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runDslSpec(f);
});

test.describe("shell-cache DSL attachment (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runDslSpec(f);
});
