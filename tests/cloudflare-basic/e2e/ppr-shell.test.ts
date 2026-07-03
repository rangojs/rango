import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
  waitForNavigation,
  goBack,
} from "./helper";

// End-to-end coverage for PPR shell caching, opt-in per route via the `ppr` path
// option (src/urls.tsx) — serving is integral to the router (no middleware) —
// backed by the app's KV-backed CFCacheStore (getShell/putShell). Runs in BOTH the dev worker and the built
// preview worker. See docs/design/ppr-shell-resume.md.
//
// Cache keys are per-URL (pathname + sorted search + ":shell"), so each test uses
// its own ?probe= query param to isolate its shell entry.
//
// Capture runs as a render-layer BACKGROUND task (router.match under a derived
// context), so the middleware calls next() exactly once. The full MISS -> capture
// -> HIT round-trip is live: the fixture route follows the PPR hole contract —
// shell material in PprShellLayout, the loader route behind route-level loading()
// (LoaderBoundary is the Suspense boundary capture postpones at). A loader route
// WITHOUT loading() awaits its loader at tree-build, so capture's masked loader
// pins the whole tree and the sanity gate refuses to store (eternal MISS — the
// shape this suite was first written in). See docs/design/ppr-shell-resume.md
// ("The hole contract").

const LOADER_DELAY_MS = 400;

// The /ppr-shell/stream + /ppr-shell/no-hole loader (loaders/ppr-shell.ts):
// outer value resolves fast, the nested pendingData promise settles ~300ms later.
const STREAM_INNER_DELAY_MS = 300;

// The shell cache only engages for HTML document GETs; mayNeedSSR treats a
// request whose Accept omits text/html as RSC and bypasses. Playwright's raw
// request.get defaults to Accept: * / *, so document probes must ask for HTML
// the way a browser navigation does.
const HTML_HEADERS = { Accept: "text/html" };

/**
 * Poll a URL until the shell cache reports HIT (the background capture landed).
 *
 * Timeout is generous (20s) because in the DEV worker (miniflare + cold vite module
 * transforms) under this suite's parallel load, the first capture can race an
 * unfinished shell and take a full retry+backoff cycle before it sticks — the very
 * cold-start path the retry-in-place exists to smooth. The built preview worker
 * captures on the first attempt (pre-built modules), so it HITs well inside this.
 */
async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 20000 });
}

/** Native fetch + incremental reader: first-chunk latency and the full HTML body. */
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
 * Fail on any hydration / minified-React console error or pageerror. Pins the
 * PPR consistency contract: a cached prelude served ahead of a freshly rendered
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

function describePprShell(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`ppr-shell caching (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    // --- Working today: engagement, bypass matrix, axis-1 render/hydration. ---

    test("engages for an HTML document GET and tags x-rango-shell: MISS", async ({
      request,
    }) => {
      const res = await request.get(f.url("/ppr-shell?probe=miss"), {
        headers: HTML_HEADERS,
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rango-shell"]).toBe("MISS");
      // The live document streamed (axis 1): the shell and the resolved hole are
      // both inline (this is NOT a composed prelude).
      const html = await res.text();
      expect(html).toContain("PPR Shell Demo");
      expect(html).toContain("Live price:");
    });

    test("bypasses non-document (RSC) requests — no shell header", async ({
      request,
    }) => {
      // Accept omits text/html: mayNeedSSR() is false, so the middleware bypasses
      // to axis 1 and never tags the response (the Flight path is untouched by PPR).
      const res = await request.get(f.url("/ppr-shell?probe=rsc"), {
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

      await page.goto(f.url("/ppr-shell?probe=render"));
      await waitForHydration(page);

      // Shell content plus the streamed live hole.
      await expect(testId(page, "ppr-shell-header")).toHaveText(
        "PPR Shell Demo",
      );
      await expect(testId(page, "ppr-price")).toContainText("Live price:");

      // The shell's interactive island hydrated: the counter responds to clicks.
      const counter = testId(page, "ppr-counter");
      await expect(counter).toHaveText("count: 0");
      await counter.click();
      await expect(counter).toHaveText("count: 1");

      // Soft-nav away then back: the return trip re-establishes /ppr-shell via a
      // client (RSC) navigation, which the shell-cache middleware bypasses. The
      // page must still render and stay interactive, with no full reload.
      await using ___ = await expectNoReload(page);
      await testId(page, "ppr-nav-counter").click();
      await waitForNavigation(page, /\/counter/);
      await expect(testId(page, "counter-title")).toBeVisible();

      await goBack(page);
      await expect(testId(page, "ppr-shell-page")).toBeVisible();
      await expect(testId(page, "ppr-price")).toContainText("Live price:");
    });

    // --- The full HIT / resume contract (MISS -> HIT, streaming order, hydration). ---

    test("first GET misses, then a later GET hits (x-rango-shell MISS -> HIT)", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell?probe=seq");
      const res1 = await request.get(url, { headers: HTML_HEADERS });
      expect(res1.headers()["x-rango-shell"]).toBe("MISS");
      await warmToHit(request, url);
    });

    test("HIT streams the cached shell first and the live hole later", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell?probe=stream");
      await warmToHit(request, url);

      const { ttfb, firstChunk, html } = await measureFirstChunk(url);

      // The frozen shell (static text + counter markup + the Suspense fallback)
      // is in the first flushed bytes; the live price is NOT.
      expect(firstChunk).toContain("PPR Shell Demo");
      expect(firstChunk).toContain("Loading price...");
      expect(firstChunk).not.toContain("Live price:");

      // The live loader content + React's $RC boundary stitch arrive later in
      // the SAME response body.
      expect(html).toContain("Live price:");
      expect(html).toContain("$RC");

      // First byte (the cached prelude) does not wait on the ~400ms live loader.
      expect(ttfb).toBeLessThan(LOADER_DELAY_MS);
    });

    // --- Replay-only capture: the shell is a PHOTOGRAPH, not a re-render. ---

    // PHYSICS hole: PprShellLayout hands a PENDING handler-created promise
    // (~250ms) to a client component that use()s it under its OWN Suspense. Real
    // I/O cannot win the capture's task-quantized quiet window, so the boundary
    // postpones: the frozen prelude carries the fallback and the resume streams
    // the value in the same body. Holes are render-defined.
    test("physics hole: a pending handler promise under Suspense postpones (fallback in prelude, value resumed)", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell?probe=physics");
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

    test("HIT page hydrates with zero errors (cached prelude / fresh payload consistency)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      using __ = guardHydrationErrors(page);

      const url = f.url("/ppr-shell?probe=browserhit");
      await warmToHit(page.request, url);

      await page.goto(url);
      await waitForHydration(page);

      await expect(testId(page, "ppr-shell-header")).toHaveText(
        "PPR Shell Demo",
      );
      await expect(testId(page, "ppr-price")).toContainText("Live price:");

      const counter = testId(page, "ppr-counter");
      await counter.click();
      await expect(counter).toHaveText("count: 1");
    });

    // --- Loader-carried promise: the deterministic streaming lane in a hole. ---

    // /ppr-shell/stream's loader resolves an outer value fast but carries a nested
    // promise the client use()s under its OWN inner Suspense. On a HIT the resume
    // streams THREE progressive layers in one response body: (1) the cached shell
    // prelude with the loading() fallback, (2) the outer loader value + the inner
    // Suspense fallback filling the hole, (3) the nested-promise inner value + the
    // $RC stitch. Capture never sees the loader (masked), so the nested promise
    // costs nothing at capture — it is deterministic, unlike a handler-passed
    // promise racing the quiet window. See docs/design/ppr-shell-resume.md.
    test("loader-carried promise HIT streams shell, then outer + inner fallback, then inner value", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell/stream?probe=lcp");
      await warmToHit(request, url);

      const { ttfb, firstChunk, html } = await measureFirstChunk(url);

      // The cached prelude (shell + the loading() fallback) is in the first bytes.
      // The outer loader value resolves fast, so it and the inner fallback may
      // batch into this same first read — but the ~300ms nested inner VALUE is
      // physically absent from the first bytes (it is not produced until long
      // after the prelude flushes). That is the streaming proof.
      expect(firstChunk).toContain("PPR Shell Demo");
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

      const url = f.url("/ppr-shell/stream?probe=lcphit");
      await warmToHit(page.request, url);

      await page.goto(url);
      await waitForHydration(page);

      await expect(testId(page, "ppr-stream-outer")).toHaveText(
        "Streamed outer",
      );
      await expect(testId(page, "ppr-stream-inner")).toContainText(
        "Streamed inner",
      );
    });

    // --- Negative contract: a loader WITHOUT loading() is not a hole. ---

    // /ppr-shell/no-hole has a loader but NO route-level loading(). The
    // loading-less branch (renderSegments) awaits loader data at tree-build, so
    // capture's masked loader pins the whole tree above <body>, the prelude comes
    // back trivial, and the sanity gate refuses to store. The route therefore
    // stays x-rango-shell: MISS forever. Crucially, axis 1 stays healthy: the
    // outer value AND the nested inner promise both stream in. No loading()
    // degrades only the caching, never the route. (The once-per-key capture
    // warning is a worker-side console.warn — not observable through this
    // Playwright harness; it is pinned by the unit test in
    // src/rsc/__tests__/shell-capture.test.ts.)
    test("no loading(): stays MISS across repeated GETs while the inner promise still streams", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell/no-hole?probe=nohole");

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
  });
}

// Deliverable 4c: PPR shell caching attached via the urls() middleware() DSL (route
// middleware) instead of router.use() (global). The middleware covers only the NEW
// /ppr-shell-dsl route; the /ppr-shell/* routes are untouched. Pins MISS -> HIT and
// HIT composition are identical under DSL attachment. See docs/design/ppr-shell-resume.md.
describePprShell("dev");
describePprShell("build");
