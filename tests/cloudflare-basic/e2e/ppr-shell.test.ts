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
import { guardHydrationErrors } from "@shared/e2e";
import { assertShellStatus } from "@rangojs/router/testing/e2e";

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
    // Dogfood the public testing helper (same contract as production header).
    assertShellStatus(
      { headers: new Headers({ "x-rango-shell": res.headers()["x-rango-shell"] ?? "" }) },
      "HIT",
    );
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
 * Split a document body at the frozen-prelude boundary. The prelude a capture
 * stores ends at </html>; everything after is the resumed tail (holes + $RC).
 * One helper so the boundary heuristic and its presence assert live in one
 * place across every HIT-composition test.
 */
function splitPrelude(html: string): { prelude: string; resumed: string } {
  const preludeEnd = html.indexOf("</html>");
  expect(preludeEnd).toBeGreaterThan(-1);
  return {
    prelude: html.slice(0, preludeEnd),
    resumed: html.slice(preludeEnd),
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
      // Explicit flight opt-in: */* now negotiates to the HTML document (which
      // engages the shell), so the bypass is pinned via the wire-format Accept.
      const res = await request.get(f.url("/ppr-shell?probe=rsc"), {
        headers: { Accept: "text/x-component" },
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
      const { prelude, resumed } = splitPrelude(html);

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

    // Fragment splice (issue #700): a HIT tail emits the stored snapshot
    // fragments VERBATIM into the hydration payload (__rangoFragment envelopes
    // the SSR resume pass and browser hydration expand) instead of
    // re-serializing the baked tree per request on the worker. A MISS (fresh
    // render) carries none; the warmed page must stay hydration-clean and its
    // hole live — the envelopes are consumer-invisible.
    test("HIT payload carries verbatim fragment envelopes; the page hydrates cleanly on workerd", async ({
      page,
    }) => {
      // Cold-graph absorber: the capture's doc segment record is written under
      // waitUntil and pinned into the snapshot only if it settles within the
      // capture's write-settle window — a COLD dev worker's first serialization
      // can outlast it, storing a snapshot-less entry whose HITs keep the full
      // tail (no fragments) until TTL. Warm a sacrificial probe first so the
      // asserted probe's capture settles in time.
      await warmToHit(page.request, f.url("/ppr-shell?probe=fragwarmup"));
      const url = f.url("/ppr-shell?probe=fragments");

      const miss = await page.request.get(url, { headers: HTML_HEADERS });
      if (miss.headers()["x-rango-shell"] === "MISS") {
        // A persisted-KV rerun may already HIT; only a genuine MISS pins the
        // no-envelope half.
        expect(await miss.text()).not.toContain("__rangoFragment");
      }

      await warmToHit(page.request, url);
      const res = await page.request.get(url, { headers: HTML_HEADERS });
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
      const { prelude, resumed } = splitPrelude(await res.text());
      expect(prelude).not.toContain("__rangoFragment");
      expect(resumed).toContain("__rangoFragment");

      using _ = expectNoPageError(page);
      using __ = guardHydrationErrors(page);
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

      await expect(testId(page, "ppr-stream-outer")).toContainText(
        "Streamed outer",
      );
      await expect(testId(page, "ppr-stream-inner")).toContainText(
        "Streamed inner",
      );
    });

    // --- Capture data snapshot: shell content drift parity. ---
    //
    // /ppr-drift bakes a value from a SHORT-ttl cache() (the "drift" profile,
    // ttl 2s) into the shell, above the live price-loader hole, on the REAL
    // KV-backed CFCacheStore. After the inner ttl expires the underlying entry is
    // gone, so a HIT tail WITHOUT the snapshot would recompute a DIFFERENT stamp
    // and drift from the frozen prelude — a hydration mismatch. The capture data
    // snapshot pins the capture-time value while the price hole stays live. See
    // docs/design/ppr-shell-resume.md.
    test("drift: a short-ttl shell value survives its ttl on a HIT (snapshot parity in raw HTML)", async ({
      request,
    }) => {
      const url = f.url("/ppr-drift?probe=drift");
      await warmToHit(request, url);

      const first = await measureFirstChunk(url);
      const captureStamp = /ppr-drift-\d+/.exec(first.html)?.[0];
      expect(
        captureStamp,
        "a drift stamp is baked into the shell",
      ).toBeTruthy();

      // Wait past the drift ttl (2s, no swr) so the underlying entry is fully
      // gone. A recompute now would yield a NEW stamp.
      await new Promise((r) => setTimeout(r, 2500));

      const second = await measureFirstChunk(url);
      const { prelude, resumed } = splitPrelude(second.html);

      // Frozen prelude still carries the capture-time stamp (shell ttl 300).
      expect(prelude).toContain(captureStamp!);
      // The freshly rendered hydration payload carries the SAME stamp — seeded
      // from the snapshot, not a recompute.
      expect(resumed).toContain(captureStamp!);
      const stamps = new Set(
        [...second.html.matchAll(/ppr-drift-\d+/g)].map((m) => m[0]),
      );
      expect(stamps).toEqual(new Set([captureStamp!]));
    });

    test("drift HIT hydrates with zero errors while the price hole stays live", async ({
      page,
      request,
    }) => {
      using _ = expectNoPageError(page);
      using __ = guardHydrationErrors(page);

      const url = f.url("/ppr-drift?probe=drifthit");
      await warmToHit(page.request, url);

      const firstHtml = await (
        await request.get(url, { headers: HTML_HEADERS })
      ).text();
      const firstSeq = Number(/data-seq="(\d+)"/.exec(firstHtml)?.[1] ?? "0");

      await new Promise((r) => setTimeout(r, 2500));

      await page.goto(url);
      await waitForHydration(page);

      await expect(testId(page, "ppr-drift-stamp")).toHaveText(/ppr-drift-\d+/);
      const price = testId(page, "ppr-price");
      await expect(price).toContainText("Live price:");
      const liveSeq = Number(await price.getAttribute("data-seq"));
      expect(liveSeq).toBeGreaterThan(firstSeq);
    });

    // /ppr-blog is the realistic fixture: the SAME components/loaders/cache()
    // wrapping as the classic /blog (sidebar parallel + ring-3 cache() ttl 60
    // whose rendered content includes a per-render timestamp), duplicated under
    // the `ppr` path option. A plain HIT (no ttl wait) must hydrate cleanly —
    // the capture data snapshot pins the cached segment and the captured theme
    // is replayed — where before the fix a HIT after the ring-3 refresh drifted
    // and detonated hydration (React regenerated the tree, wiping the FOUC theme
    // class). /blog itself stays non-ppr so the classic blog-cache suite is
    // isolated from capture interference; this twin pins the theme + snapshot
    // combination end-to-end on the real KV-backed CFCacheStore.
    test("ppr-blog HIT hydrates cleanly (theme + snapshot end-to-end)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      using __ = guardHydrationErrors(page);

      const url = f.url("/ppr-blog");
      await warmToHit(page.request, url);

      await page.goto(url);
      await waitForHydration(page);

      await expect(testId(page, "blog-title")).toHaveText("Blog");
      // The ring-3-cached cache-info segment (per-render timestamp) is present
      // and did not detonate hydration.
      await expect(testId(page, "cache-info")).toContainText(
        "cached at the edge",
      );
      // The sidebar parallel slot rendered (its loader is a cached parallel).
      await expect(testId(page, "blog-sidebar")).toBeVisible();
    });

    test("ppr-blog post HIT hydrates cleanly (slug route, same realistic shape)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      using __ = guardHydrationErrors(page);

      const url = f.url("/ppr-blog/getting-started-with-rsc");
      await warmToHit(page.request, url);

      await page.goto(url);
      await waitForHydration(page);

      await expect(testId(page, "post-title")).toHaveText(
        "Getting Started with React Server Components",
      );
      await expect(testId(page, "cache-info")).toContainText(
        "cached at the edge",
      );
    });

    // --- Negative contract: a loader WITHOUT loading() is not a hole. ---

    // /ppr-shell/no-hole has a loader but NO route-level loading(): the BAKE
    // lane (docs/design/loader-container-bake.md). The loader executes during
    // capture; its settled container (the outer label) bakes into the prelude;
    // the nested pendingData promise postpones at the consumer's own inner
    // Suspense — a hole. On every HIT the snapshot's loader family overlays
    // the recorded container onto the fresh run (outer label PINNED at its
    // capture-time seq) while the nested promise stays live (inner seq
    // advances per request). Runs on the real KV-backed CFCacheStore under
    // workerd, so the loader-family snapshot round-trips the KV envelope.
    test("no loading() (bake lane): HITs with the container baked+pinned and the nested promise live", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell/no-hole?probe=nohole");
      await warmToHit(request, url);

      const { html } = await measureFirstChunk(url);
      const { prelude, resumed } = splitPrelude(html);

      expect(prelude).toMatch(/Streamed outer \d+/);
      expect(prelude).toContain("Loading inner...");
      expect(prelude).not.toMatch(/Streamed inner \d+/);
      expect(resumed).toMatch(/Streamed inner \d+/);

      const second = await measureFirstChunk(url);
      const outerSeq = (h: string) =>
        Number(h.match(/Streamed outer (\d+)/)?.[1]);
      const innerSeq = (h: string) =>
        Number(h.match(/Streamed inner (\d+)/)?.[1]);
      expect(outerSeq(second.html)).toBe(outerSeq(html));
      expect(innerSeq(second.html)).toBeGreaterThan(innerSeq(html)!);
    });

    // /ppr-shell/settled: nested-promise SHAPE is the liveness declaration.
    // A bake-lane loader's nested promise that is ALREADY RESOLVED at
    // container return previously won the capture window and its VALUE was
    // snapshot-pinned — every HIT then served the capture-time value to every
    // visitor (found live: a storefront basket, with the capturing session's
    // identifiers, frozen into the shared shell and served to anonymous
    // requests). Nested thenables are now MASKED at capture regardless of
    // settle timing: the consumer's own Suspense postpones (its fallback bakes
    // as the hole) and every HIT streams the FRESH value. The consumer still
    // receives a real promise, so the original #438 regression stays
    // impossible. Runs on the real KV-backed CFCacheStore under workerd, so
    // the hole-marker record round-trips the KV envelope.
    test("bake lane, nested promise settled inside the window: holes anyway — outer pins, nested value stays FRESH per request", async ({
      request,
      page,
    }) => {
      const url = f.url("/ppr-shell/settled?probe=settled");
      await warmToHit(request, url);

      const { html } = await measureFirstChunk(url);
      const outerSeq = (h: string) =>
        Number(h.match(/Settled outer (\d+)/)?.[1]);
      const fastSeq = (h: string) => Number(h.match(/Settled fast (\d+)/)?.[1]);
      // Parity: the outer (non-promise) container material is snapshot-pinned.
      expect(outerSeq(html)).toBeGreaterThan(0);
      // The frozen prelude holds the consumer's Suspense fallback, never a
      // pinned nested value — the nested promise holes by declaration.
      const { prelude } = splitPrelude(html);
      expect(prelude).toContain("fast pending...");
      expect(prelude).not.toMatch(/Settled fast \d+/);
      // Liveness: the nested value is a FRESH execution's and advances per HIT.
      expect(fastSeq(html)).toBeGreaterThan(outerSeq(html)!);
      const second = await measureFirstChunk(url);
      expect(outerSeq(second.html)).toBe(outerSeq(html));
      expect(fastSeq(second.html)).toBeGreaterThan(fastSeq(html)!);

      // Browser: the HIT hydrates cleanly — use(data.fast) still receives a
      // real promise (the fresh one), so #438 cannot recur.
      using __ = guardHydrationErrors(page);
      await page.goto(url);
      await waitForHydration(page);
      // Scope to the PprShellSettled container (data-testid="ppr-settled").
      // When the nested promise's Flight payload lands client-side before fizz's
      // `$RC("B:0","S:0")` completeSegment script executes (a streaming race the
      // #706 fragment splice widens — the baked payload is now a byte copy that
      // finishes well ahead of the resume), React client-renders the dehydrated
      // boundary in place and leaves fizz's HIDDEN segment container
      // (`<div hidden id="S:0">`, a direct child of <body>) orphaned in the DOM.
      // That orphan carries the `hidden` attribute — invisible, zero layout, out
      // of the a11y tree — but it holds a second `ppr-settled-fast` node, so a
      // bare testid locator strict-mode-collides with it. The container scope
      // keeps only the visible in-place copy (the orphan lives outside it).
      const settled = page.getByTestId("ppr-settled");
      await expect(settled.getByTestId("ppr-settled-label")).toHaveText(
        /Settled outer \d+/,
      );
      await expect(settled.getByTestId("ppr-settled-fast")).toHaveText(
        /Settled fast \d+/,
      );
    });

    // --- Per-request nonce via the ContextVar token: ppr stays on axis 1 (#656) ---
    //
    // /ppr-nonce sets a fresh per-request nonce via the `nonce` token in ROUTE
    // middleware (ctx.set(nonce, crypto.randomUUID())). A shell is shared per
    // host+URL, so capturing it would freeze one request's nonce for every visitor
    // and break CSP. The commit-point gate reads the token AFTER the route
    // middleware runs, so a token nonce gates PPR exactly like a provider nonce:
    // pure axis 1, NO capture, NO x-rango-shell header (mirrors the missing-store
    // diagnostic) — so the route can never HIT, and every GET carries a DISTINCT
    // nonce. This also pins the commit-point ordering (the DSL middleware's token
    // write is visible to the gate). Before the fix the gate saw only the
    // provider-threaded nonce, so this route entered capture (tagged MISS) and
    // would have frozen one nonce for all. (The once-per-key worker warning is a
    // server-side console.warn, pinned by the unit test in
    // src/rsc/__tests__/rsc-rendering-shell-ppr.test.ts.)
    test("token nonce (route middleware) keeps a ppr route on axis 1: repeated GETs never HIT and carry a distinct nonce each", async ({
      request,
    }) => {
      const url = f.url("/ppr-nonce?probe=noncetoken");
      const seen = new Set<string>();

      for (let i = 0; i < 4; i++) {
        const res = await request.get(url, { headers: HTML_HEADERS });
        expect(res.status()).toBe(200);
        expect(
          res.headers()["x-rango-shell"],
          `request #${i} must never HIT (token nonce forces axis 1)`,
        ).not.toBe("HIT");

        const html = await res.text();
        const value = /data-nonce="([^"]+)"/.exec(html)?.[1];
        expect(
          value,
          "the per-request nonce is rendered into the shell",
        ).toBeTruthy();
        expect(value).not.toBe("(none)");
        seen.add(value!);

        // The live price hole still renders fresh under axis 1.
        expect(html).toContain("Live price:");

        if (i < 3) await new Promise((r) => setTimeout(r, 350));
      }

      // Per-request freshness: a distinct nonce every request. A frozen shared
      // shell (the bug) would have served ONE nonce across all four.
      expect(seen.size).toBe(4);
    });

    // --- The layout-loader trap (storefront shape) and its escape. ---

    // /ppr-shell/layout-loader: the LAYOUT registers PprChromeLoader (100ms,
    // no loading() on the layout — bake lane) and the ppr child route keeps
    // its own loader behind loading() (live lane). The layout container bakes
    // (the capture gate holds for its real latency); the price hole stays live
    // and fresh per request. This WAS the eternal-MISS trap before the bake
    // lane — the child's loading() could not unpin the layout's await.
    test("layout loader without loading() (bake lane): HITs — layout container bakes, child loading() hole stays live", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell/layout-loader?probe=trap");
      await warmToHit(request, url);

      const { html } = await measureFirstChunk(url);
      const { prelude, resumed } = splitPrelude(html);

      expect(prelude).toContain("Trap chrome static text");
      expect(prelude).toContain("Loading price...");
      expect(resumed).toContain("Live price:");

      const second = await measureFirstChunk(url);
      const seqOf = (h: string) => Number(h.match(/data-seq="(\d+)"/)?.[1]);
      expect(seqOf(second.html)).toBeGreaterThan(seqOf(html)!);
    });

    // /ppr-shell/layout-loader-bare: the LITERAL storefront-homepage shape —
    // a bare ppr route (no loader, no loading(), no use list) under the
    // loader-registering layout. Formerly the canonical dead-end; now the
    // layout container bakes and the static page HITs with no loading()
    // anywhere.
    test("bare ppr route under a loader layout (the storefront homepage shape): HITs with no loading() anywhere", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell/layout-loader-bare?probe=bare");
      await warmToHit(request, url);

      const { html } = await measureFirstChunk(url);
      const { prelude } = splitPrelude(html);

      expect(prelude).toContain("Trap chrome static text");
      expect(prelude).toContain("Bare home static content");
    });

    // /ppr-shell/slot-hole: the escape (skills/ppr "layout-with-loaders
    // playbook") on the real KV-backed CFCacheStore under workerd. The same
    // chrome data is owned by a @badge parallel slot with its OWN loading(), so
    // the layout has no loaders to await: the shell captures with chrome + the
    // static page + the frozen badge fallback in the prelude, the badge value
    // streams in the resumed tail, and it stays live (seq advances) across
    // HITs. Neither the layout nor the route carries loading().
    test("layout data in a parallel slot with its own loading(): flips to HIT, badge fallback frozen, badge value live per request", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell/slot-hole?probe=slot");
      await warmToHit(request, url);

      const { html } = await measureFirstChunk(url);
      const { prelude, resumed } = splitPrelude(html);

      expect(prelude).toContain("Slot chrome static text");
      expect(prelude).toContain("Slot home static content");
      expect(prelude).toContain("badge pending...");
      expect(prelude).not.toMatch(/badge-\d/);
      expect(resumed).toMatch(/badge-\d+/);

      // Liveness: a second HIT re-runs the slot loader (seq advances) while
      // the prelude still freezes the fallback.
      const second = await measureFirstChunk(url);
      const secondPrelude = splitPrelude(second.html).prelude;
      expect(secondPrelude).toContain("badge pending...");
      const firstSeq = Number(html.match(/badge-(\d+)/)?.[1]);
      const secondSeq = Number(second.html.match(/badge-(\d+)/)?.[1]);
      expect(secondSeq).toBeGreaterThan(firstSeq);
    });

    // Shell fast path (docs/design/shell-fast-path.md): on a HIT the tail
    // match hits the captured doc segment record and REPLAYS the handler
    // layer — only middleware and DSL loaders execute. The fixture's
    // per-layer counters ride out through the loader (live lane), so two
    // consecutive HITs expose exactly which layers ran in between. The SWR
    // recapture is the deliberate exception (it re-runs handlers in a
    // background capture); the fixture's ttl (300s) keeps it out of the test
    // window.
    test("fast-path HIT executes ONLY middleware and loaders — path/layout/parallel handlers are replayed, not run", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell/exec-matrix?probe=exec");
      await warmToHit(request, url);

      const readHit = async (): Promise<{
        counters: {
          middleware: number;
          layout: number;
          parallel: number;
          path: number;
          loader: number;
        };
        html: string;
      }> => {
        const res = await request.get(url, { headers: HTML_HEADERS });
        expect(res.status()).toBe(200);
        expect(res.headers()["x-rango-shell"]).toBe("HIT");
        const html = await res.text();
        const match = html.match(
          /data-testid="ppr-exec-counters"[^>]*>(\{[^<]+\})</,
        );
        expect(
          match,
          "streamed counters JSON present in the document",
        ).toBeTruthy();
        // React escapes double quotes in text nodes; decode before parsing.
        return {
          counters: JSON.parse(match![1].replace(/&quot;/g, '"')),
          html,
        };
      };

      const first = (await readHit()).counters;
      const second = await readHit();

      // Live layers: exactly one execution per HIT.
      expect(second.counters.middleware).toBe(first.middleware + 1);
      expect(second.counters.loader).toBe(first.loader + 1);

      // Handler layers: replayed from the captured record — frozen across HITs.
      expect(second.counters.path).toBe(first.path);
      expect(second.counters.layout).toBe(first.layout);
      expect(second.counters.parallel).toBe(first.parallel);

      // The replayed handler output still renders (structure intact).
      expect(second.html).toContain("Exec matrix static chrome");
      expect(second.html).toContain("exec badge");
    });

    // Prerender + ppr COMPOSITION (docs/design/shell-fast-path.md): one route
    // carries both a build-time Prerender handler (trie pr:true) and the ppr
    // option. Build-time segments bake into the frozen prelude; the slot-owned
    // loader is the live hole (seq advances per HIT). The Prerender handler
    // never executes at serve (production evicts it to a stub).
    test("prerender + ppr compose: build-time segments are the frozen prelude, the slot loader streams fresh per HIT", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell/prerendered/alpha?probe=pp");
      const miss = await request.get(url, { headers: HTML_HEADERS });
      expect(miss.status()).toBe(200);
      expect(miss.headers()["x-rango-shell"]).toBe("MISS");
      expect(await miss.text()).toContain(
        "Prerendered shell content for alpha",
      );
      await warmToHit(request, url);

      const { html } = await measureFirstChunk(url);
      const { prelude, resumed } = splitPrelude(html);
      expect(prelude).toContain("Prerendered shell content for alpha");
      expect(prelude).toContain("Loading pp seq...");
      expect(prelude).not.toContain("ppr-pp-seq:");
      expect(resumed).toContain("ppr-pp-seq:");

      // Slot loader liveness: seq advances across HITs while the shell replays.
      const second = await request.get(url, { headers: HTML_HEADERS });
      expect(second.headers()["x-rango-shell"]).toBe("HIT");
      const seq1 = Number(html.match(/ppr-pp-seq: (\d+)/)?.[1]);
      const seq2 = Number(
        (await second.text()).match(/ppr-pp-seq: (\d+)/)?.[1],
      );
      expect(seq2).toBe(seq1 + 1);

      // Per-param shells: the sibling prerendered slug HITs with its own content.
      const betaUrl = f.url("/ppr-shell/prerendered/beta?probe=pp");
      await warmToHit(request, betaUrl);
      const beta = await (
        await request.get(betaUrl, { headers: HTML_HEADERS })
      ).text();
      expect(splitPrelude(beta).prelude).toContain(
        "Prerendered shell content for beta",
      );
    });

    // -------------------------------------------------------------------
    // Producer B (#699): the shell entry is produced at BUILD time (dev: on
    // demand via /__rsc_shell), so the FIRST request already HITs. Build
    // entries cover the BARE pathname only — the ?probe= URLs above carry a
    // search string and keep exercising the runtime-capture lanes untouched.
    // Bare-path usage is partitioned across tests (fullyParallel-safe):
    // beta = first-request assertion, alpha = liveness; eviction has its own
    // route + tag (/ppr-shell/prerendered-evict/gamma); the "warm" slug in
    // the beforeAll absorbs the cold-graph cost (dev: the on-demand capture
    // compiles the temp-server SSR graph on first use).
    // -------------------------------------------------------------------

    test.beforeAll(async ({ playwright }) => {
      const ctx = await playwright.request.newContext();
      try {
        await warmToHit(
          ctx as unknown as Page["request"],
          f.url("/ppr-shell/prerendered/warm"),
        );
      } finally {
        await ctx.dispose();
      }
    });

    test("build-time shell: the FIRST request serves x-rango-shell: HIT with the frozen prelude", async ({
      request,
    }) => {
      const res = await request.get(f.url("/ppr-shell/prerendered/beta"), {
        headers: HTML_HEADERS,
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
      const { prelude, resumed } = splitPrelude(await res.text());
      expect(prelude).toContain("Prerendered shell content for beta");
      expect(prelude).toContain("Loading pp seq...");
      expect(prelude).not.toContain("ppr-pp-seq:");
      expect(resumed).toContain("ppr-pp-seq:");
    });

    test("build-time shell: loaders stay live across baked-entry HITs (seq advances)", async ({
      request,
    }) => {
      const readSeq = (html: string): number => {
        const match = html.match(/ppr-pp-seq: (\d+)/);
        expect(match, "live seq present in the document").toBeTruthy();
        return Number(match![1]);
      };
      const url = f.url("/ppr-shell/prerendered/alpha");
      const first = await request.get(url, { headers: HTML_HEADERS });
      expect(first.headers()["x-rango-shell"]).toBe("HIT");
      const seq1 = readSeq(await first.text());
      const second = await request.get(url, { headers: HTML_HEADERS });
      expect(second.headers()["x-rango-shell"]).toBe("HIT");
      expect(readSeq(await second.text())).toBe(seq1 + 1);
    });

    test("updateTag evicts the build-time shell; the runtime capture then owns the route", async ({
      request,
    }) => {
      const url = f.url("/ppr-shell/prerendered-evict/gamma");
      const baked = await request.get(url, { headers: HTML_HEADERS });
      expect(baked.headers()["x-rango-shell"]).toBe("HIT");
      expect(await baked.text()).toContain("Evictable shell content for gamma");

      // Awaitable invalidation: the KV tag marker lands before the response,
      // so the next read is deterministically MISS — the baked entry is
      // immutable, but the marker comparison (isTagsInvalidatedSince against
      // the entry's build-time createdAt) rejects it.
      const invalidate = await request.get(
        f.url("/test/invalidate-tag/ppr-pp-evict-shell"),
      );
      expect(invalidate.status()).toBe(200);

      const evicted = await request.get(url, { headers: HTML_HEADERS });
      expect(evicted.headers()["x-rango-shell"]).toBe("MISS");

      // Producer A takes over: the MISS scheduled a runtime capture that
      // stores a runtime entry (the runtime store is read before the manifest).
      await warmToHit(request, url);
    });
  });
}

// Deliverable 4c: PPR shell caching attached via the urls() middleware() DSL (route
// middleware) instead of router.use() (global). The middleware covers only the NEW
// /ppr-shell-dsl route; the /ppr-shell/* routes are untouched. Pins MISS -> HIT and
// HIT composition are identical under DSL attachment. See docs/design/ppr-shell-resume.md.
describePprShell("dev");
describePprShell("build");

// ---------------------------------------------------------------------
// Dev boot-race readiness (#719 P2/P3) on the Cloudflare temp-server path — the
// preset where getOrCreateTempServer stands up a temp Node server on the first
// shell request and the runners/registry readiness sites fire. Own isolated dev
// workers, no warm-up slug (the describePprShell beforeAll masks the boot
// window). NO production sibling: production serves the first-request HIT from a
// build manifest with no /__rsc_shell endpoint / temp server / re-poll loop
// (covered by describePprShell("build")). A dev-only mechanism has no production
// counterpart (hard-rule dev+prod pairing, N/A justified).
// ---------------------------------------------------------------------

test.describe("ppr-shell dev readiness: injected boot-race (#719)", () => {
  // Deterministic regression guard: RANGO_E2E_INJECT_SHELL_NOTREADY makes the
  // dev endpoint emit ONE reopt-class NOT-READY per pathname through the REAL
  // classifier before serving, so the read-through's re-poll runs end-to-end
  // (a natural cold race settles too fast to guard this). The FIRST request to a
  // virgin slug must still recover to x-rango-shell: HIT.
  const f = useFixture({
    root: ".",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { RANGO_E2E_INJECT_SHELL_NOTREADY: "1" } },
  });

  test("injected reopt NOT-READY: the FIRST request re-polls to HIT", async ({
    request,
  }) => {
    const res = await request.get(f.url("/ppr-shell/prerendered/alpha"), {
      headers: HTML_HEADERS,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  });
});

test.describe("ppr-shell dev readiness: cold first request (#719)", () => {
  // Natural cold path (weak guard per #719: a fast machine can settle before the
  // first servable request), but on Cloudflare the temp server is genuinely cold
  // on the first shell request (the main-worker warmup does not create it). A
  // virgin Prerender+ppr URL as the literal FIRST request on a fresh worker —
  // HIT on request one, or a MISS that heals to HIT inside the readiness window.
  const f = useFixture({ root: ".", mode: "dev", isolatedServer: true });

  test("cold virgin route: first request HITs (or heals within the readiness window)", async ({
    request,
  }) => {
    const url = f.url("/ppr-shell/prerendered/beta");
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    if (res.headers()["x-rango-shell"] !== "HIT") {
      await warmToHit(request, url);
    }
  });
});
