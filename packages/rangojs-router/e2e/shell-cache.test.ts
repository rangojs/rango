import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
  waitForNavigation,
  goBack,
} from "./helper";

// End-to-end coverage for PPR shell caching, opt-in per route via the `ppr` path
// option (test-app/src/urls/shell-cache.tsx) — serving is integral to the router
// (no middleware to mount) and backed by the app's MemorySegmentCacheStore
// (getShell/putShell). Runs in BOTH the dev server and the built preview server.
// See docs/design/ppr-shell-resume.md.
//
// Each describe uses isolatedServer so the shell-cache route's per-request work
// (and the background-capture error below) stays contained to this suite's own
// server. Cache keys are per-URL (pathname + sorted search + ":shell"); tests use
// their own ?probe= query param to isolate their shell entry.
//
// Capture runs as a render-layer BACKGROUND task (router.match under a derived
// context, mixed-chain: uncached segments execute fresh, middleware never
// re-runs). The full MISS -> capture -> HIT round-trip is live: the fixture
// follows the PPR hole doctrine —
// shell material in a layout segment, the loader route behind route-level
// loading() (LoaderBoundary is the Suspense boundary capture postpones at). A
// loader route WITHOUT loading() awaits its loader at tree-build, so capture's
// masked loader pins the whole tree and the sanity gate refuses to store (eternal
// MISS — the shape this suite was first written in). See
// docs/design/ppr-shell-resume.md ("The hole contract").

const LOADER_DELAY_MS = 400;

// The /shell-cache/stream + /shell-cache/no-hole loader (shell-cache.defs.ts):
// outer value resolves fast, the nested pendingData promise settles ~300ms later.
const STREAM_INNER_DELAY_MS = 300;

// The shell cache only engages for HTML document GETs; mayNeedSSR treats a request
// whose Accept omits text/html as RSC and bypasses. Playwright's raw request.get
// defaults to Accept: * / *, so document probes must ask for HTML the way a browser
// navigation does.
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

/**
 * Fail on any hydration / minified-React console error or pageerror. Pins the PPR
 * consistency contract: a cached prelude served ahead of a freshly rendered
 * hydration payload must not drift.
 */
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

function runShellCacheSpec(f: Fixture): void {
  // --- Working today: engagement, bypass matrix, live-path render/hydration. ---

  test("engages for an HTML document GET and tags x-rango-shell: MISS", async ({
    request,
  }) => {
    const res = await request.get(f.url("/shell-cache?probe=miss"), {
      headers: HTML_HEADERS,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("MISS");
    const html = await res.text();
    expect(html).toContain("Shell Cache Demo");
    expect(html).toContain("Live price:");
  });

  test("bypasses non-document (RSC) requests — no shell header", async ({
    request,
  }) => {
    const res = await request.get(f.url("/shell-cache?probe=rsc"), {
      headers: { Accept: "*/*" },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBeUndefined();
  });

  test("renders and hydrates on the live path, and soft-nav to the route works", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    await page.goto(f.url("/shell-cache?probe=render"));
    await waitForHydration(page);

    await expect(testId(page, "shell-cache-header")).toHaveText(
      "Shell Cache Demo",
    );
    await expect(testId(page, "shell-price")).toContainText("Live price:");

    // The shell's interactive island hydrated: the counter responds to clicks.
    const counter = testId(page, "shell-counter");
    await expect(counter).toHaveText("count: 0");
    await counter.click();
    await expect(counter).toHaveText("count: 1");

    // Soft-nav away then back: the return trip re-establishes /shell-cache via a
    // client (RSC) navigation, which the shell-cache middleware bypasses. The page
    // must still render and stay interactive, with no full reload.
    await using ___ = await expectNoReload(page);
    await testId(page, "shell-nav-home").click();
    await waitForNavigation(page, /\/$/);

    await goBack(page);
    await expect(testId(page, "shell-cache-page")).toBeVisible();
    await expect(testId(page, "shell-price")).toContainText("Live price:");
  });

  // --- The full HIT / resume contract (MISS -> HIT, streaming order, hydration). ---

  test("first GET misses, then a later GET hits (x-rango-shell MISS -> HIT)", async ({
    request,
  }) => {
    const url = f.url("/shell-cache?probe=seq");
    const res1 = await request.get(url, { headers: HTML_HEADERS });
    expect(res1.headers()["x-rango-shell"]).toBe("MISS");
    await warmToHit(request, url);
  });

  test("HIT streams the cached shell first and the live hole later", async ({
    request,
  }) => {
    const url = f.url("/shell-cache?probe=stream");
    await warmToHit(request, url);

    const { ttfb, firstChunk, html } = await measureFirstChunk(url);

    // The frozen shell (static text + counter markup + the Suspense fallback) is
    // in the first flushed bytes; the live price is NOT.
    expect(firstChunk).toContain("Shell Cache Demo");
    expect(firstChunk).toContain("Loading price...");
    expect(firstChunk).not.toContain("Live price:");

    // The live loader content + React's $RC boundary stitch arrive later in the
    // SAME response body.
    expect(html).toContain("Live price:");
    expect(html).toContain("$RC");

    // First byte (the cached prelude) does not wait on the ~400ms live loader.
    expect(ttfb).toBeLessThan(LOADER_DELAY_MS);
  });

  // --- The hole doctrine: PHYSICS and HANDLES holes ---

  // PHYSICS hole: ShellCacheLayout hands a PENDING handler-created promise
  // (~250ms) to a client component that use()s it under its OWN Suspense. Real
  // I/O cannot win the capture's task-quantized quiet window, so the boundary
  // postpones: the frozen prelude carries the fallback, and the resume streams
  // the value in the same body. Holes are render-defined — no registration
  // needed beyond the Suspense boundary.
  test("physics hole: a pending handler promise under Suspense postpones (fallback in prelude, value resumed)", async ({
    request,
  }) => {
    const url = f.url("/shell-cache?probe=physics");
    await warmToHit(request, url);

    const { html } = await measureFirstChunk(url);
    const preludeEnd = html.indexOf("</html>");
    expect(preludeEnd).toBeGreaterThan(-1);
    const prelude = html.slice(0, preludeEnd);
    const resumed = html.slice(preludeEnd);

    expect(prelude).toContain("physics pending...");
    expect(prelude).not.toContain("PHYSICS-HOLE-VALUE");
    expect(resumed).toContain("PHYSICS-HOLE-VALUE");
    expect(html).toContain("$RC");
  });

  // HANDLES contract ("nesting = liveness"): a TOP-LEVEL pushed handle promise is
  // awaited server-side before SSR and BAKED into the prelude (the capture gate
  // holds for the same await), while a promise NESTED in a pushed container
  // passes through verbatim and streams into the consumer's own Suspense — a
  // hole. A promise nested inside your data is never baked; the container
  // settles.
  test("handles pair: top-level push(promise) bakes into the prelude; nested push({x: promise}) streams as a hole", async ({
    request,
  }) => {
    const url = f.url("/shell-cache?probe=handles");
    await warmToHit(request, url);

    const { html } = await measureFirstChunk(url);
    const preludeEnd = html.indexOf("</html>");
    expect(preludeEnd).toBeGreaterThan(-1);
    const prelude = html.slice(0, preludeEnd);
    const resumed = html.slice(preludeEnd);

    // Top-level promise push (~150ms real latency): resolved BEFORE the shell
    // froze — its value is shell material, in the prelude.
    expect(prelude).toContain("TOP-LEVEL-BAKED");
    // Nested promise in a pushed container: the prelude froze the consumer's
    // fallback; the value streams in the resumed portion.
    expect(prelude).toContain("nested pending...");
    expect(prelude).not.toContain("NESTED-HANDLE-STREAMED");
    expect(resumed).toContain("NESTED-HANDLE-STREAMED");
  });

  test("HIT page hydrates with zero errors (cached prelude / fresh payload consistency)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const url = f.url("/shell-cache?probe=browserhit");
    await warmToHit(page.request, url);

    await page.goto(url);
    await waitForHydration(page);

    await expect(testId(page, "shell-cache-header")).toHaveText(
      "Shell Cache Demo",
    );
    await expect(testId(page, "shell-price")).toContainText("Live price:");

    const counter = testId(page, "shell-counter");
    await counter.click();
    await expect(counter).toHaveText("count: 1");
  });

  // --- Loader-carried promise: the deterministic streaming lane in a hole. ---

  // /shell-cache/stream's loader resolves an outer value fast but carries a nested
  // promise the client use()s under its OWN inner Suspense. On a HIT the resume
  // streams THREE progressive layers in one response body: (1) the cached shell
  // prelude with the loading() fallback, (2) the outer loader value + the inner
  // Suspense fallback filling the hole, (3) the nested-promise inner value + the
  // $RC stitch. Capture never sees the loader (masked), so the nested promise
  // costs nothing at capture — deterministic, unlike a handler-passed promise
  // racing the quiet window. See docs/design/ppr-shell-resume.md.
  test("loader-carried promise HIT streams shell, then outer + inner fallback, then inner value", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/stream?probe=lcp");
    await warmToHit(request, url);

    const { ttfb, firstChunk, html } = await measureFirstChunk(url);

    // The cached prelude (shell + the loading() fallback) is in the first bytes.
    // The outer loader value resolves fast, so it and the inner fallback may batch
    // into this same first read — but the ~300ms nested inner VALUE is physically
    // absent from the first bytes (it is not produced until long after the prelude
    // flushes). That is the streaming proof.
    expect(firstChunk).toContain("Shell Cache Demo");
    expect(firstChunk).toContain("Loading stream...");
    expect(firstChunk).not.toContain("Streamed inner");

    // All three layers land in the SAME response body, strictly ordered:
    // shell/loading() fallback -> outer value + inner Suspense fallback ->
    // nested-promise inner value, each stitched by React's $RC.
    const iShell = html.indexOf("Loading stream..."); // layer 1 (prelude)
    const iOuter = html.indexOf("Streamed outer"); // layer 2 (hole fill)
    const iInnerFallback = html.indexOf("Loading inner..."); // layer 2 (inner)
    const iInner = html.indexOf("Streamed inner"); // layer 3 (inner value)
    expect(iShell).toBeGreaterThanOrEqual(0);
    expect(iOuter).toBeGreaterThan(iShell);
    expect(iInnerFallback).toBeGreaterThan(iShell);
    expect(iInner).toBeGreaterThan(iOuter);
    expect(iInner).toBeGreaterThan(iInnerFallback);
    // React's boundary stitch for the resumed holes.
    expect(html).toContain("$RC");

    // First byte (the cached prelude) does not wait on the ~300ms nested promise.
    expect(ttfb).toBeLessThan(STREAM_INNER_DELAY_MS);
  });

  test("loader-carried promise HIT hydrates with zero errors", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const url = f.url("/shell-cache/stream?probe=lcphit");
    await warmToHit(page.request, url);

    await page.goto(url);
    await waitForHydration(page);

    await expect(testId(page, "shell-stream-outer")).toHaveText(
      "Streamed outer",
    );
    await expect(testId(page, "shell-stream-inner")).toContainText(
      "Streamed inner",
    );
  });

  // --- Negative contract: a loader WITHOUT loading() is not a hole. ---

  // /shell-cache/no-hole has a loader but NO route-level loading(). The
  // loading-less branch (renderSegments) awaits loader data at tree-build, so
  // capture's masked loader pins the whole tree above <body>, the prelude comes
  // back trivial, and the sanity gate refuses to store. The route stays
  // x-rango-shell: MISS forever. Crucially, axis 1 stays healthy: the outer value
  // AND the nested inner promise both stream in. No loading() degrades only the
  // caching, never the route. (The once-per-key capture warning is a worker-side
  // console.warn — not observable through this Playwright harness; it is pinned by
  // the unit test in src/rsc/__tests__/shell-capture.test.ts.)
  test("no loading(): stays MISS across repeated GETs while the inner promise still streams", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/no-hole?probe=nohole");

    // Six GETs spaced past the background capture window: every capture attempt
    // deterministically refuses, so the header never flips to HIT.
    for (let i = 0; i < 6; i++) {
      const res = await request.get(url, { headers: HTML_HEADERS });
      expect(res.status()).toBe(200);
      expect(
        res.headers()["x-rango-shell"],
        `request #${i} must stay MISS`,
      ).toBe("MISS");

      const html = await res.text();
      // Axis 1 is healthy: outer value AND the nested inner promise stream in.
      expect(html).toContain("Streamed outer");
      expect(html).toContain("Streamed inner");

      if (i < 5) await new Promise((r) => setTimeout(r, 350));
    }
  });
}

test.describe("shell-cache (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runShellCacheSpec(f);
});

test.describe("shell-cache (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runShellCacheSpec(f);
});
