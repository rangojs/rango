import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  isPrefetchRequest,
  testId,
  waitForNavigation,
  goBack,
} from "./helper";
import { guardHydrationErrors } from "@shared/e2e";
import {
  assertPprReplayStatus,
  assertShellStatus,
  parsePprReplayStatus,
} from "@rangojs/router/testing/e2e";
import type { ShellExecCounters } from "./test-app/src/urls/shell-cache.defs";

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
// loader WITHOUT loading() is the BAKE lane (loader-container-bake): it executes
// at capture, its settled container bakes into the shell (snapshot-pinned on
// HITs), and promises nested in the container hole at the consumer's own
// Suspense. See docs/design/ppr-shell-resume.md and
// docs/design/loader-container-bake.md.

const LOADER_DELAY_MS = 400;

// The /shell-cache/stream + /shell-cache/no-hole loader (shell-cache.defs.ts):
// outer value resolves fast, the nested pendingData promise settles ~300ms later.
const STREAM_INNER_DELAY_MS = 300;

// Last row index of the /shell-cache/outlined fixture's big section
// (OUTLINED_ROW_COUNT - 1 in test-app/src/urls/shell-cache.tsx).
const OUTLINED_LAST_ROW = 9999;

// The shell cache only engages for HTML document GETs; mayNeedSSR treats a request
// whose Accept omits text/html as RSC and bypasses. Playwright's raw request.get
// defaults to Accept: * / *, so document probes must ask for HTML the way a browser
// navigation does.
const HTML_HEADERS = { Accept: "text/html" };

async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    // Dogfood the public testing helper (same contract as production header).
    assertShellStatus(
      {
        headers: new Headers({
          "x-rango-shell": res.headers()["x-rango-shell"] ?? "",
        }),
      },
      "HIT",
    );
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

function runShellCacheSpec(f: Fixture, production: boolean): void {
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
    // Explicit flight opt-in: */* now negotiates to the HTML document (which
    // engages the shell), so the RSC bypass is pinned via the wire-format
    // Accept the flight transport actually sends.
    const res = await request.get(f.url("/shell-cache?probe=rsc"), {
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

  // Script strategy inside the composite HIT (src/ssr/preinit-client-references.ts):
  // the frozen prelude carries the executing module scripts (bootstrap always;
  // preinit-upgraded chunk scripts in build, where client-reference deps exist),
  // and the resumed tail re-emits NONE of them — the preinit dedupe markers and
  // cleared bootstrap fields ride inside the serialized postponed state.
  test("HIT: executing module scripts live in the prelude, exactly once each", async ({
    request,
  }) => {
    const url = f.url("/shell-cache?probe=scripts");
    await warmToHit(request, url);

    const { html } = await measureFirstChunk(url);
    const { prelude, resumed } = splitPrelude(html);

    const executingSrcs = (part: string) =>
      [...part.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)]
        .filter((m) => m[0].includes('type="module"'))
        .map((m) => m[1]!);

    // The executing bootstrap (id="_R_") is frozen into the prelude.
    expect(prelude).toContain('id="_R_"');
    const preludeSrcs = executingSrcs(prelude);
    expect(preludeSrcs.length).toBeGreaterThan(0);

    // The resume pass never duplicates a script the shell already shipped.
    const resumedSrcs = executingSrcs(resumed);
    for (const src of preludeSrcs) {
      expect(resumedSrcs, `resume re-emitted ${src}`).not.toContain(src);
    }
    const seen = new Set<string>();
    for (const src of preludeSrcs) {
      expect(seen.has(src), `prelude duplicated ${src}`).toBe(false);
      seen.add(src);
    }
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
    const { prelude, resumed } = splitPrelude(html);

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
    const { prelude, resumed } = splitPrelude(html);

    // Top-level promise push (~150ms real latency): resolved BEFORE the shell
    // froze — its value is shell material, in the prelude.
    expect(prelude).toContain("TOP-LEVEL-BAKED");
    // Nested promise in a pushed container: the prelude froze the consumer's
    // fallback; the value streams in the resumed portion.
    expect(prelude).toContain("nested pending...");
    expect(prelude).not.toContain("NESTED-HANDLE-STREAMED");
    expect(resumed).toContain("NESTED-HANDLE-STREAMED");
    // Nested promise that is ALREADY RESOLVED at push time — the extreme of
    // the settle race. Shape is the liveness declaration: the capture masks
    // nested thenables in pushed handle containers, so this holes exactly like
    // the slow one instead of baking its value into the shared shell.
    expect(prelude).toContain("nested-fast pending...");
    expect(prelude).not.toContain("NESTED-FAST-STREAMED");
    expect(resumed).toContain("NESTED-FAST-STREAMED");
  });

  // THEME fidelity on a HIT (regression: PPR'd blog routes rendered light for
  // dark-theme visitors and the toggle went dead). initialTheme is per-request
  // metadata; the resume tail must replay the CAPTURE's initialTheme so the
  // resume tree matches the frozen prelude, while the visitor's real theme is
  // applied pre-paint by the FOUC script and re-synced post-mount by
  // ThemeProvider. Warm with NO cookie (capture bakes the default light), then
  // visit with a dark cookie: the page must be dark, hydrated, and interactive.
  test("HIT with a different visitor theme: dark cookie wins visually, zero hydration errors, interactive", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const url = f.url("/shell-cache?probe=themefid");
    await warmToHit(page.request, url);

    await context.addCookies([
      {
        name: "theme",
        value: "dark",
        url: f.url("/"),
      },
    ]);
    await page.goto(url);
    await waitForHydration(page);

    // FOUC script applied the visitor's theme pre-paint; ThemeProvider's
    // post-mount re-sync keeps state in line — the class must be dark and STAY
    // dark (no hydration clobber back to the captured light).
    await expect
      .poll(async () =>
        page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      )
      .toBe(true);
    await page.waitForTimeout(200);
    expect(
      await page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      ),
    ).toBe(true);

    // The layout renders RAW theme text (ThemeToggle) inside the cached shell —
    // the exact shape that detonated the original bug. The prelude bakes the
    // capture's "light"; hydration must succeed against it (the provider
    // initializer renders the replayed initialTheme, never storage), then the
    // post-mount re-sync converges the provider state to the visitor's cookie.
    await expect(testId(page, "shell-theme-current-theme")).toHaveText(
      "Current theme: dark",
    );

    // Interactivity survived the themed resume (the original bug killed it).
    const counter = testId(page, "shell-counter");
    await counter.click();
    await expect(counter).toHaveText("count: 1");
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

  // --- Capture data snapshot: shell content drift parity. ---
  //
  // /shell-cache/drift bakes a value from a SHORT-ttl cache() (the "drift"
  // profile, ttl 1s / swr 0) into the shell, above the live price-loader hole.
  // After the inner ttl expires the underlying entry is GONE, so a HIT tail
  // WITHOUT the snapshot would recompute a DIFFERENT stamp and drift from the
  // frozen prelude — a hydration text mismatch. The capture data snapshot pins
  // the capture-time value: the shell region reproduces byte-identically while
  // the price hole stays live. See docs/design/ppr-shell-resume.md.
  test("drift: a short-ttl shell value survives its ttl on a HIT (snapshot parity in raw HTML)", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/drift?probe=drift");
    await warmToHit(request, url);

    // The stamp baked into the captured prelude.
    const first = await measureFirstChunk(url);
    const captureStamp = /drift-\d+/.exec(first.html)?.[0];
    expect(captureStamp, "a drift stamp is baked into the shell").toBeTruthy();

    // Wait past the drift ttl (1s, no swr) so the underlying entry fully expires
    // (not merely goes stale). A recompute now would yield a NEW stamp.
    await new Promise((r) => setTimeout(r, 1500));

    const second = await measureFirstChunk(url);
    const { prelude, resumed } = splitPrelude(second.html);

    // The frozen prelude still carries the capture-time stamp (shell ttl 300).
    expect(prelude).toContain(captureStamp!);
    // The freshly rendered hydration payload (resumed portion, inlined Flight
    // data) carries the SAME stamp — seeded from the snapshot, not a recompute.
    expect(resumed).toContain(captureStamp!);
    // Nowhere did a NEW drift stamp appear: the drifted region is pinned.
    const stamps = new Set(
      [...second.html.matchAll(/drift-\d+/g)].map((m) => m[0]),
    );
    expect(stamps).toEqual(new Set([captureStamp!]));
  });

  test("drift HIT hydrates with zero errors while the price hole stays live", async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const url = f.url("/shell-cache/drift?probe=drifthit");
    await warmToHit(page.request, url);

    // Baseline seq from a HIT before the wait (the live price hole advances every
    // request even while the shell is served from the cached prelude).
    const firstHtml = await (
      await request.get(url, { headers: HTML_HEADERS })
    ).text();
    const firstSeq = Number(/data-seq="(\d+)"/.exec(firstHtml)?.[1] ?? "0");

    // Past the drift ttl: without the snapshot the baked stamp would drift and
    // detonate hydration.
    await new Promise((r) => setTimeout(r, 1500));

    await page.goto(url);
    await waitForHydration(page);

    // The baked shell stamp is present and hydration succeeded (guard = zero
    // hydration errors; the whole point of the snapshot).
    await expect(testId(page, "drift-stamp")).toHaveText(/drift-\d+/);
    // The price hole filled with LIVE data whose seq advanced past the baseline.
    const price = testId(page, "shell-price");
    await expect(price).toContainText("Live price:");
    const liveSeq = Number(await price.getAttribute("data-seq"));
    expect(liveSeq).toBeGreaterThan(firstSeq);
  });

  // --- Snapshot size cap (issue #651): over-cap snapshot skipped, serving intact. ---

  // /shell-cache/snapshot-cap declares ppr.maxSnapshotBytes: 64 — far below the
  // snapshot its capture records (the cap-stamp "use cache" item alone exceeds
  // it) — so every capture stores the shell WITHOUT its snapshot (the skip +
  // once-per-key report mechanics are pinned in shell-capture.test.ts). The
  // contract pinned HERE: the cap degrades pinning, never serving — the route
  // still flips MISS -> HIT and the HIT hydrates with zero errors (the
  // cap-stamp's default-profile ttl outlasts the test, so the un-pinned live
  // re-read agrees with the frozen prelude), while the price hole stays live.
  test("size-cap fallback: an over-cap snapshot still stores the shell and the HIT hydrates cleanly", async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const url = f.url("/shell-cache/snapshot-cap?probe=capfallback");
    await warmToHit(page.request, url);

    // Raw-wire HIT: the shell serves from the store even though its snapshot
    // was dropped, with the baked cap-stamp in the document.
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
    const html = await res.text();
    expect(html).toMatch(/cap-stamp-\d+/);
    const firstSeq = Number(/data-seq="(\d+)"/.exec(html)?.[1] ?? "0");

    // Browser HIT: zero hydration errors (the guards above), the shell island
    // is interactive, and the live hole advances past the baseline.
    await page.goto(url);
    await waitForHydration(page);
    await expect(testId(page, "cap-stamp")).toHaveText(/cap-stamp-\d+/);
    const counter = testId(page, "shell-counter");
    await expect(counter).toHaveText("count: 0");
    await counter.click();
    await expect(counter).toHaveText("count: 1");
    const price = testId(page, "shell-price");
    await expect(price).toContainText("Live price:");
    const liveSeq = Number(await price.getAttribute("data-seq"));
    expect(liveSeq).toBeGreaterThan(firstSeq);
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

    await expect(testId(page, "shell-stream-outer")).toContainText(
      "Streamed outer",
    );
    await expect(testId(page, "shell-stream-inner")).toContainText(
      "Streamed inner",
    );
  });

  // --- Per-request nonce via the ContextVar token: ppr stays on axis 1 (#656) ---
  //
  // /shell-cache/nonce-token sets a fresh per-request nonce via the `nonce` token
  // in ROUTE middleware (ctx.set(nonce, crypto.randomUUID())). A shell is shared
  // per host+URL, so capturing it would freeze one request's nonce for every
  // visitor and break CSP. The commit-point gate reads the token AFTER the route
  // middleware runs, so a token nonce gates PPR exactly like a provider nonce:
  // pure axis 1, NO capture. Like the missing-store diagnostic, a nonce-gated ppr
  // route emits NO x-rango-shell header (it never participates in PPR) — so it can
  // never flip to HIT, and every GET carries a DISTINCT nonce. That also pins the
  // commit-point ordering: the DSL middleware's token write is visible to the
  // gate. Before the fix the gate only saw the provider-threaded nonce, so this
  // route entered capture (tagged MISS) and would have frozen one nonce for all.
  //
  // (The once-per-key worker warning is a server-side console.warn — not
  // observable through this Playwright harness; it is pinned by the unit test in
  // src/rsc/__tests__/rsc-rendering-shell-ppr.test.ts.)
  test("token nonce (route middleware) keeps a ppr route on axis 1: repeated GETs never HIT and carry a distinct nonce each", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/nonce-token?probe=noncetoken");
    const seen = new Set<string>();

    // Space GETs past the background-capture window so, if the gate wrongly
    // allowed capture, a later GET would flip to HIT and freeze one nonce.
    for (let i = 0; i < 4; i++) {
      const res = await request.get(url, { headers: HTML_HEADERS });
      expect(res.status()).toBe(200);
      // Nonce-gated: pure axis 1, no PPR participation — never a HIT, no header
      // (mirrors the missing-store diagnostic; the warn-once explains why).
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

    // Per-request freshness: a distinct nonce every request. A frozen shared shell
    // (the bug) would have served ONE nonce across all four.
    expect(seen.size).toBe(4);
  });

  // --- The bake lane: loaders WITHOUT loading() follow the container rule. ---
  // (docs/design/loader-container-bake.md — one promise doctrine for handlers,
  // handles, AND loaders: the settled container bakes, a promise nested inside
  // it holes at the consumer's own Suspense.)

  // /shell-cache/no-hole has a loader but NO route-level loading(): the BAKE
  // lane. The loader executes during capture; its settled container (the outer
  // label) bakes into the prelude; the nested pendingData promise postpones at
  // the consumer's own inner Suspense — a hole. On every HIT the capture
  // snapshot's loader family overlays the recorded container onto the fresh
  // run (the outer label is PINNED at its capture-time seq, byte-parity with
  // the frozen prelude) while the nested promise stays live (inner seq
  // advances per request).
  test("no loading() (bake lane): HITs with the container baked+pinned and the nested promise live", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/no-hole?probe=nohole");
    await warmToHit(request, url);

    const { html } = await measureFirstChunk(url);
    const { prelude, resumed } = splitPrelude(html);

    // Container baked into the frozen prelude; nested promise is a hole (its
    // fallback froze, its value resumes).
    expect(prelude).toMatch(/Streamed outer \d+/);
    expect(prelude).toContain("Loading inner...");
    expect(prelude).not.toMatch(/Streamed inner \d+/);
    expect(resumed).toMatch(/Streamed inner \d+/);

    // Pinning vs liveness across HITs: the baked container replays the
    // CAPTURE-time value (snapshot overlay — no drift, no hydration mismatch)
    // while the nested hole re-runs fresh (loader seq advances).
    const second = await measureFirstChunk(url);
    const outerSeq = (h: string) =>
      Number(h.match(/Streamed outer (\d+)/)?.[1]);
    const innerSeq = (h: string) =>
      Number(h.match(/Streamed inner (\d+)/)?.[1]);
    expect(outerSeq(second.html)).toBe(outerSeq(html));
    expect(innerSeq(second.html)).toBeGreaterThan(innerSeq(html)!);
  });

  // /shell-cache/settled: nested-promise SHAPE is the liveness declaration.
  // A bake-lane loader's nested promise that is ALREADY RESOLVED at container
  // return previously won the capture window and its VALUE was snapshot-pinned
  // — every HIT then served the capture-time value to every visitor (found
  // live: a storefront basket, with the capturing session's basketId/customer
  // data, frozen into the shared shell and served to anonymous requests).
  // Nested thenables are now MASKED at capture regardless of settle timing:
  // the consumer's own Suspense postpones (its fallback bakes as the hole in
  // the prelude) and every HIT streams the FRESH value. The consumer still
  // receives a real promise, so the original #438 regression (raw value handed
  // to use()) stays impossible by construction.
  test("bake lane, nested promise settled inside the window: holes anyway — outer pins, nested value stays FRESH per request", async ({
    request,
    page,
  }) => {
    const url = f.url("/shell-cache/settled?probe=settled");
    await warmToHit(request, url);

    const { html } = await measureFirstChunk(url);
    const outerSeq = (h: string) => Number(h.match(/Settled outer (\d+)/)?.[1]);
    const fastSeq = (h: string) => Number(h.match(/Settled fast (\d+)/)?.[1]);
    // Parity: the outer (non-promise) container material is snapshot-pinned.
    expect(outerSeq(html)).toBeGreaterThan(0);
    // The frozen prelude holds the consumer's Suspense fallback, never a
    // pinned nested value — the nested promise holes by declaration.
    const { prelude } = splitPrelude(html);
    expect(prelude).toContain("fast pending...");
    expect(prelude).not.toMatch(/Settled fast \d+/);
    // Liveness: the nested value in the full body is a FRESH execution's
    // (seq beyond the pinned capture seq), and it advances on every HIT.
    expect(fastSeq(html)).toBeGreaterThan(outerSeq(html)!);
    const second = await measureFirstChunk(url);
    expect(outerSeq(second.html)).toBe(outerSeq(html));
    expect(fastSeq(second.html)).toBeGreaterThan(fastSeq(html)!);

    // Browser: the HIT hydrates cleanly — use(data.fast) still receives a real
    // promise (the fresh one), so #438 cannot recur. The SSR'd text is in the
    // DOM before hydration, so waitForHydration keeps the error window inside
    // the guard.
    using __ = guardHydrationErrors(page);
    await page.goto(url);
    await waitForHydration(page);
    // Scope to the ShellSettledValue container (data-testid="shell-settled").
    // When the nested promise's Flight payload lands client-side before fizz's
    // `$RC("B:0","S:0")` completeSegment script executes (a streaming race the
    // #706 fragment splice widens — the baked payload is now a byte copy that
    // finishes well ahead of the resume), React client-renders the dehydrated
    // boundary in place and leaves fizz's HIDDEN segment container
    // (`<div hidden id="S:0">`, a direct child of <body>) orphaned in the DOM.
    // That orphan carries the `hidden` attribute — invisible, zero layout, out
    // of the a11y tree — but it holds a second `shell-settled-fast` node, so a
    // bare testid locator strict-mode-collides with it. The container scope
    // keeps only the visible in-place copy (the orphan lives outside it).
    const settled = testId(page, "shell-settled");
    await expect(settled.getByTestId("shell-settled-label")).toHaveText(
      /Settled outer \d+/,
    );
    await expect(settled.getByTestId("shell-settled-fast")).toHaveText(
      /Settled fast \d+/,
    );
  });

  // --- The layout-loader shapes (storefront) on the bake lane. ---

  // /shell-cache/layout-loader: the LAYOUT registers ShellChromeLoader (100ms,
  // no loading() on the layout — bake lane) and the ppr child route keeps its
  // own loader behind loading() (live lane). The layout container bakes (the
  // capture gate holds for its real latency); the price hole stays live and
  // fresh per request. This WAS the eternal-MISS trap before the bake lane —
  // the child's loading() could not unpin the layout's boundary-less await.
  test("layout loader without loading() (bake lane): HITs — layout container bakes, child loading() hole stays live", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/layout-loader?probe=trap");
    await warmToHit(request, url);

    const { html } = await measureFirstChunk(url);
    const { prelude, resumed } = splitPrelude(html);

    expect(prelude).toContain("Trap chrome static text");
    // Live-lane price hole: fallback frozen, value resumed fresh.
    expect(prelude).toContain("Loading price...");
    expect(resumed).toContain("Live price:");

    // The hole is live: price seq advances across HITs.
    const second = await measureFirstChunk(url);
    const seqOf = (h: string) => Number(h.match(/data-seq="(\d+)"/)?.[1]);
    expect(seqOf(second.html)).toBeGreaterThan(seqOf(html)!);
  });

  // /shell-cache/bake-slow: the PIN-FIRST optimization (loader-cache.ts
  // `if (!recorded.holes)`). The layout registers a 600ms bake-lane loader
  // (no loading() on the layout) returning a plain HOLE-FREE container. Its
  // container bakes into the snapshot's loader family hole-free, so on a HIT the
  // payload resolves the loaderData from the PIN immediately instead of gating
  // on the fresh 600ms run (which still executes ungated for side effects). The
  // child keeps a fast ~30ms price hole behind loading() so a real shell
  // captures. Two guarantees in one: the served label is pinned (frozen across
  // HITs, not the advancing fresh seq) AND the pin makes the full HIT response
  // beat the 600ms fresh run.
  test("pin-first bake lane: a HIT serves the pinned 600ms container fast and frozen across HITs", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/bake-slow?probe=bakeslow");
    await warmToHit(request, url);

    // request.get buffers the WHOLE body, so elapsed covers stream completion.
    // Without pin-first the payload gates on the fresh 600ms bake run
    // (elapsed >= 600ms); pinned, the recorded container resolves immediately
    // and only the ~30ms live hole remains — the 400ms bound leaves a 200ms+
    // margin for CI noise either side.
    const start = Date.now();
    const res = await request.get(url, { headers: HTML_HEADERS });
    const elapsed = Date.now() - start;
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
    const html = await res.text();

    // The pinned bake label rides the HIT body beside the live hole's content.
    const captured = /bake-\d+/.exec(html)?.[0];
    expect(captured, "the pinned bake label rides the HIT body").toBeTruthy();
    expect(html).toContain("Live price:");

    expect(
      elapsed,
      `HIT full-response ${elapsed}ms must beat the 600ms fresh bake run`,
    ).toBeLessThan(400);

    // Frozen: a second HIT serves the SAME captured label (the pin, not the
    // fresh seq that keeps advancing in the background) while the price hole
    // stays live.
    const second = await request.get(url, { headers: HTML_HEADERS });
    expect(second.headers()["x-rango-shell"]).toBe("HIT");
    const secondHtml = await second.text();
    expect(/bake-\d+/.exec(secondHtml)?.[0]).toBe(captured);
    expect(secondHtml).toContain("Live price:");
  });

  // /shell-cache/guard: the identity wall. A bake-lane loader (no loading())
  // reads cookies() — during capture the guard throws inside the loader, the
  // context flag makes the capture REFUSE deterministically, and the route
  // stays MISS forever. Axis 1 keeps serving the per-user value normally.
  // (The once-per-key refusal warning is a worker-side console.warn — pinned
  // by the unit tests in src/rsc/__tests__/shell-capture.test.ts.)
  test("bake-lane loader reading cookies(): capture refused, stays MISS, axis 1 keeps the per-user value", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/guard?probe=guard");

    for (let i = 0; i < 4; i++) {
      const res = await request.get(url, {
        headers: { ...HTML_HEADERS, Cookie: "session=user-a" },
      });
      expect(res.status()).toBe(200);
      expect(
        res.headers()["x-rango-shell"],
        `request #${i} must stay MISS`,
      ).toBe("MISS");

      const html = await res.text();
      expect(html).toContain("user-a");

      if (i < 3) await new Promise((r) => setTimeout(r, 350));
    }
  });

  // /shell-cache/layout-loader-bare: the LITERAL storefront-homepage shape —
  // a bare ppr route (no loader, no loading(), no use list) under the
  // loader-registering layout. Formerly the canonical dead-end; now the layout
  // container bakes and the fully-static page HITs with no loading() anywhere.
  test("bare ppr route under a loader layout (the storefront homepage shape): HITs with no loading() anywhere", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/layout-loader-bare?probe=bare");
    await warmToHit(request, url);

    const { html } = await measureFirstChunk(url);
    const { prelude } = splitPrelude(html);

    expect(prelude).toContain("Trap chrome static text");
    expect(prelude).toContain("Bare home static content");
  });

  // /shell-cache/slot-hole: the escape from the trap above (skills/ppr
  // "layout-with-loaders playbook"). The same chrome data is owned by a @badge
  // parallel slot with its OWN loading(), so the layout node has no loaders to
  // await: the shell captures with chrome + the static page + the badge
  // FALLBACK frozen in the prelude, the badge value streams in the resumed
  // tail, and it stays live (seq advances) across HITs. Neither the layout nor
  // the route carries loading().
  test("layout data in a parallel slot with its own loading(): flips to HIT, badge fallback frozen, badge value live per request", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/slot-hole?probe=slot");
    await warmToHit(request, url);

    const { html } = await measureFirstChunk(url);
    const { prelude, resumed } = splitPrelude(html);

    expect(prelude).toContain("Slot chrome static text");
    expect(prelude).toContain("Slot home static content");
    expect(prelude).toContain("badge pending...");
    expect(prelude).not.toMatch(/badge-\d/);
    expect(resumed).toMatch(/badge-\d+/);

    // Liveness: a second HIT re-runs the slot loader (seq advances) while the
    // prelude still freezes the fallback.
    const second = await measureFirstChunk(url);
    const secondPrelude = splitPrelude(second.html).prelude;
    expect(secondPrelude).toContain("badge pending...");
    const firstSeq = Number(html.match(/badge-(\d+)/)?.[1]);
    const secondSeq = Number(second.html.match(/badge-(\d+)/)?.[1]);
    expect(secondSeq).toBeGreaterThan(firstSeq);
  });

  // /shell-cache/slot-use + /shell-cache/slot-use/other: the CONSUMPTION-LANE
  // RULE (issue #672 / #674; semantic-matrix row "ppr-capture-handler-ctx-use").
  // Handlers consume cookie-reading loaders server-side via `await
  // ctx.use(...)`; during capture the loaders EXECUTE and the identity reads
  // are EXEMPT from the shell guard (mirroring cache() purity semantics) — no
  // refusal, both routes flip MISS->HIT. WHERE the value lands splits by what
  // shields it, and this test pins both halves on both routes:
  // - the CHIP (layout handler, UNREGISTERED loader, plain shell material):
  //   the capture-time value — seq AND cookie identity — BAKES into the
  //   shared prelude, identical across HITs and across visitors. The frozen
  //   identity is the rule's documented footgun; client-side useLoader
  //   (/shell-cache/slot-hole above) is the live lane.
  // - the @srvBadge SLOT (same loader also registered live-lane on the
  //   parallel: loader()+loading()): the SEGMENT lane is unchanged by the
  //   rule — its masked loaderData pins the slot boundary, so the slot stays
  //   a LIVE hole: fallback frozen in the prelude, value fresh (and
  //   visitor-correct) per serve.
  for (const [label, route, staticText] of [
    ["first route", "/shell-cache/slot-use", "Srv slot home static content"],
    [
      "sibling route",
      "/shell-cache/slot-use/other",
      "Srv slot other static content",
    ],
  ] as const) {
    test(`handler ctx.use of cookie-reading loaders (${label}): HIT; unshielded value BAKED and frozen, live-lane slot stays a fresh hole`, async ({
      request,
    }) => {
      const url = f.url(`${route}?probe=srv-slot`);
      await warmToHit(request, url);

      const { html } = await measureFirstChunk(url);
      const { prelude, resumed } = splitPrelude(html);

      expect(prelude).toContain("Srv slot chrome static text");
      expect(prelude).toContain(staticText);

      // BAKED half: the chip (capture ran cookie-less -> "anon") is IN the
      // shared prelude.
      const bakedChip = prelude.match(/srv-chip-(\d+)-anon/);
      expect(bakedChip).not.toBeNull();

      // LIVE half: the slot's registered live-lane segment keeps the badge a
      // hole — fallback frozen, value only in the resumed tail.
      expect(prelude).toContain("srv badge pending...");
      expect(prelude).not.toMatch(/srv-badge-\d/);
      expect(resumed).toMatch(/srv-badge-\d+-anon/);

      // Frozen across HITs AND visitors: a later HIT carrying a visitor
      // cookie still serves the SAME baked chip seq + identity in the
      // prelude — the shared-copy footgun the rule accepts and documents —
      // while the live badge hole resolves the REAL visitor, fresh seq.
      const second = await request.get(url, {
        headers: { ...HTML_HEADERS, Cookie: "srv_visitor=user-a" },
      });
      expect(second.status()).toBe(200);
      expect(second.headers()["x-rango-shell"]).toBe("HIT");
      const secondHtml = await second.text();
      const secondPrelude = splitPrelude(secondHtml).prelude;
      const secondChip = secondPrelude.match(/srv-chip-(\d+)-anon/);
      expect(secondChip).not.toBeNull();
      expect(secondChip![1]).toBe(bakedChip![1]);
      expect(secondPrelude).not.toMatch(/srv-chip-\d+-user-a/);
      expect(secondHtml).toMatch(/srv-badge-\d+-user-a/);
      const badgeSeq = (h: string) => Number(h.match(/srv-badge-(\d+)-/)?.[1]);
      expect(badgeSeq(secondHtml)).toBeGreaterThan(badgeSeq(html));
    });
  }

  // --- Serve-gate hardening (issue #684 SSR-03/SSR-04): a corrupt or
  // stale-build stored entry must degrade to a WORKING axis-1 MISS — never the
  // pre-fix failure mode (200 + full static prelude committed, then the tail
  // throws: a visually complete page that never hydrates, re-served on every
  // request until TTL). The /shell-cache/__corrupt fixture endpoint overwrites
  // the stored entry in place; the follow-up MISS's background recapture then
  // heals the key back to a HIT.
  for (const [label, mode, probe] of [
    ["corrupt postponed blob", "postponed", "corrupt-postponed"],
    ["stale buildVersion", "build", "stale-build"],
  ] as const) {
    test(`a stored entry with a ${label} degrades to a working MISS and the recapture heals it`, async ({
      request,
    }) => {
      const target = `/shell-cache?probe=${probe}`;
      const url = f.url(target);
      await warmToHit(request, url);

      const corrupt = await request.get(
        f.url(
          `/shell-cache/__corrupt?target=${encodeURIComponent(target)}&mode=${mode}`,
        ),
      );
      expect(corrupt.status()).toBe(200);
      expect(await corrupt.json()).toEqual({ ok: true, found: true });

      // The poisoned entry fails the pre-commit gate: plain MISS, page intact.
      const res = await request.get(url, { headers: HTML_HEADERS });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rango-shell"]).toBe("MISS");
      expect(await res.text()).toContain("shell-cache-header");

      // The MISS scheduled a recapture that overwrites the poisoned entry.
      await warmToHit(request, url);
    });
  }

  // --- Shell fast path: the execution matrix (docs/design/shell-fast-path.md).
  // On a fast-path HIT the tail match hits the captured doc segment record and
  // REPLAYS the handler layer: only middleware and DSL loaders execute. The
  // fixture's per-layer counters ride out through the loader (live lane), so
  // two consecutive HITs expose exactly which layers ran in between. The SWR
  // recapture is the deliberate exception (it re-runs handlers in a background
  // capture); the fixture's ttl (300s) keeps it out of the test window.
  test("fast-path HIT executes ONLY middleware and loaders — path/layout/parallel handlers are replayed, not run", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/exec-matrix?probe=exec");
    await warmToHit(request, url);

    const readHit = async (): Promise<{
      counters: {
        middleware: number;
        transitionWhen: number;
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
        /data-testid="shell-exec-counters"[^>]*>(\{[^<]+\})</,
      );
      expect(
        match,
        "streamed counters JSON present in the document",
      ).toBeTruthy();
      // React escapes double quotes in text nodes; decode before parsing.
      return { counters: JSON.parse(match![1].replace(/&quot;/g, '"')), html };
    };

    const first = (await readHit()).counters;
    const second = await readHit();

    // Live layers: exactly one execution per HIT.
    expect(second.counters.middleware).toBe(first.middleware + 1);
    expect(second.counters.transitionWhen).toBe(first.transitionWhen + 1);
    expect(second.counters.loader).toBe(first.loader + 1);

    // Handler layers: replayed from the captured record — frozen across HITs.
    expect(second.counters.path).toBe(first.path);
    expect(second.counters.layout).toBe(first.layout);
    expect(second.counters.parallel).toBe(first.parallel);

    // The replayed handler output still renders (structure intact, not blank).
    expect(second.html).toContain("Exec matrix static chrome");
    expect(second.html).toContain("exec badge");
  });

  test("partial navigation replays the PPR segment shell while middleware and loaders stay live", async ({
    page,
  }) => {
    const target = f.url("/shell-cache/exec-matrix");
    await warmToHit(page.request, target);

    using _ = expectNoPageError(page);
    const navigateFromFreshDocument = async () => {
      await page.goto(f.url("/"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);
      const partialResponsePromise = page.waitForResponse((response) => {
        const responseUrl = new URL(response.url());
        return (
          responseUrl.pathname === "/shell-cache/exec-matrix" &&
          responseUrl.searchParams.has("_rsc_partial")
        );
      });
      await testId(page, "nav-ppr-exec").click();
      const partialResponse = await partialResponsePromise;
      await waitForNavigation(page, /\/shell-cache\/exec-matrix$/);
      assertPprReplayStatus(
        { headers: new Headers(partialResponse.headers()) },
        { outcome: "HIT", freshness: "fresh" },
      );
      // Fragment splice (#700) on navigation: a replay HIT's segments ride as
      // verbatim __rangoFragment envelopes; the client expands them before
      // render, so the content assertions below prove they are
      // consumer-invisible.
      expect(await partialResponse.text()).toContain("__rangoFragment");
      await expect(testId(page, "shell-exec-chrome")).toHaveText(
        "Exec matrix static chrome",
      );
      return JSON.parse(
        (await testId(page, "shell-exec-counters").textContent())!,
      ) as ShellExecCounters;
    };

    const first = await navigateFromFreshDocument();
    const second = await navigateFromFreshDocument();

    expect(second.middleware).toBe(first.middleware + 1);
    expect(second.transitionWhen).toBe(first.transitionWhen + 1);
    expect(second.loader).toBe(first.loader + 1);
    expect(second.path).toBe(first.path);
    expect(second.layout).toBe(first.layout);
    expect(second.parallel).toBe(first.parallel);
  });

  test("partial PPR replay applies a fresh transition({ when }) drop decision", async ({
    page,
  }) => {
    const target = f.url("/shell-cache/exec-matrix?transition=drop");
    await warmToHit(page.request, target);

    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    await testId(page, "nav-ppr-exec-drop").click();

    await expect(testId(page, "shell-exec-fallback")).toBeVisible();
    await waitForNavigation(
      page,
      /\/shell-cache\/exec-matrix\?transition=drop$/,
    );
    await expect(testId(page, "shell-exec-chrome")).toHaveText(
      "Exec matrix static chrome",
    );
  });

  // --- Storefront shape: replay composed with an ancestor cache() scope. ---
  // (urls/shell-cache.tsx `cache({ ttl: 30, swr })` wrapping ppr routes — the
  // rsc-cloudflare-app diagnosis shape, where replay used to be structurally
  // dead: eternal `snapshot-miss` plus two wasted getShell reads per nav.)

  test("storefront shape: cold explicit tier — navigation replays the shell snapshot (HIT) with the handler frozen", async ({
    page,
  }) => {
    const probe = crypto.randomUUID();
    const target = f.url(`/shell-cache/scoped?probe=${probe}`);
    await warmToHit(page.request, target);

    using _ = expectNoPageError(page);
    const navigateFromFreshDocument = async () => {
      await page.goto(f.url("/"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);
      const partialResponsePromise = page.waitForResponse((response) => {
        const responseUrl = new URL(response.url());
        return (
          responseUrl.pathname === "/shell-cache/scoped" &&
          responseUrl.searchParams.get("probe") === probe &&
          responseUrl.searchParams.has("_rsc_partial")
        );
      });
      await page.evaluate((href) => {
        const link = document.createElement("a");
        link.href = href;
        link.dataset.prefetch = "false";
        link.dataset.testid = "shell-scoped-entry";
        link.textContent = "Enter scoped fixture";
        document.body.append(link);
      }, target);
      await testId(page, "shell-scoped-entry").click();
      const partialResponse = await partialResponsePromise;
      await expect(testId(page, "shell-scoped-chrome")).toHaveText(
        "Scoped chrome static content",
      );
      assertPprReplayStatus(
        { headers: new Headers(partialResponse.headers()) },
        { outcome: "HIT", freshness: "fresh" },
      );
      return (await testId(page, "shell-scoped-home").textContent())!;
    };

    // The ring-3 partial tier is cold for this probe (no partial rendered
    // fresh), so BOTH navigations must be supplied by the seeded doc record —
    // and the page handler stays frozen at its capture-time execution.
    const first = await navigateFromFreshDocument();
    const second = await navigateFromFreshDocument();
    expect(first).toMatch(/^scoped-home-execution-\d+$/);
    expect(second).toBe(first);
  });

  test("storefront shape: warm explicit tier serves the partial and reports explicit-cache-hit, never a false HIT", async ({
    page,
  }) => {
    const probe = crypto.randomUUID();
    const target = f.url(`/shell-cache/scoped?probe=${probe}`);
    const waitForPartial = () =>
      page.waitForResponse((response) => {
        const responseUrl = new URL(response.url());
        return (
          responseUrl.pathname === "/shell-cache/scoped" &&
          responseUrl.searchParams.get("probe") === probe &&
          responseUrl.searchParams.has("_rsc_partial")
        );
      });
    const enterFixture = async (suffix: string) => {
      await page.goto(f.url("/"));
      await waitForHydration(page);
      const partialResponsePromise = waitForPartial();
      await page.evaluate(
        ([href, id]) => {
          const link = document.createElement("a");
          link.href = href!;
          link.dataset.prefetch = "false";
          link.dataset.testid = id!;
          link.textContent = "Enter scoped fixture";
          document.body.append(link);
        },
        [target, `shell-scoped-entry-${suffix}`],
      );
      await testId(page, `shell-scoped-entry-${suffix}`).click();
      const partialResponse = await partialResponsePromise;
      await expect(testId(page, "shell-scoped-chrome")).toHaveText(
        "Scoped chrome static content",
      );
      return {
        response: partialResponse,
        stamp: (await testId(page, "shell-scoped-home").textContent())!,
      };
    };

    using _ = expectNoPageError(page);
    // 1. Shell cold: the first navigation renders fresh (bounded no-entry
    //    bypass) and WRITES the ring-3 partial entry (explicit scope, ttl 30).
    const cold = await enterFixture("cold");
    assertPprReplayStatus(
      { headers: new Headers(cold.response.headers()) },
      { outcome: "BYPASS", reason: "no-entry" },
    );

    // 2. Warm the document shell (captures the doc segment record + docKey).
    await warmToHit(page.request, target);

    // 3. Navigate again within the explicit ttl: the consumer's tier stays
    //    authoritative — served from the ring-3 entry written in step 1 (same
    //    execution stamp), reported honestly as explicit-cache-hit.
    const warm = await enterFixture("warm");
    assertPprReplayStatus(
      { headers: new Headers(warm.response.headers()) },
      { outcome: "BYPASS", reason: "explicit-cache-hit" },
    );
    // The served segments came from the EXPLICIT tier, not the shell
    // snapshot: the tier holds step 1's proactive re-render (a later
    // execution than the cold response — null-component partials re-render
    // in the background before caching), while the snapshot's doc record
    // froze the capture render's own execution. Equality with the document
    // HIT's baked stamp would mean the snapshot supplied the match.
    const doc = await page.request.get(target, { headers: HTML_HEADERS });
    // Raw HTML carries React's text-node separator between the literal and
    // the interpolated counter ("…execution-<!-- -->N").
    const docStamp = (await doc.text()).match(
      /scoped-home-execution-(?:<!-- -->)?(\d+)/,
    )?.[1];
    expect(docStamp).toBeTruthy();
    expect(warm.stamp.match(/\d+$/)![0]).not.toBe(docStamp);
  });

  test("storefront shape: cache(false) and condition() opt-outs both report cache-disabled and render fresh", async ({
    request,
  }) => {
    // cache(false) is static and bypasses before any shell read; a false
    // condition() is request-time state, refused by the lookup itself and
    // reported post-match — same header, same absolute opt-out, different
    // decision point (the gate must not pre-decide a flappable predicate).
    for (const [path, testid] of [
      ["/shell-cache/scoped-optout", "shell-scoped-optout"],
      ["/shell-cache/scoped-condition", "shell-scoped-condition"],
    ] as const) {
      const probe = crypto.randomUUID();
      const target = f.url(`${path}?probe=${probe}`);
      // Document PPR is orthogonal to the route cache opt-out: the shell
      // still captures and HITs.
      await warmToHit(request, target);

      const replay = await request.get(
        `${target}&_rsc_partial=true&_rsc_segments=`,
        { headers: { "X-RSC-Router-Client-Path": f.url("/") } },
      );
      expect(replay.status()).toBe(200);
      assertPprReplayStatus(
        { headers: new Headers(replay.headers()) },
        { outcome: "BYPASS", reason: "cache-disabled" },
      );
      expect(await replay.text()).toContain(testid);
    }
  });

  test("a context-less partial probe (curl shape) reports no-navigation-context, not a snapshot miss", async ({
    request,
  }) => {
    const probe = crypto.randomUUID();
    const target = f.url(`/shell-cache/scoped?probe=${probe}`);
    // Warmed shell with an eligible snapshot: the old flow would seed it,
    // fail to match (no navigation context), and blame `snapshot-miss`.
    await warmToHit(request, target);

    const replay = await request.get(
      `${target}&_rsc_partial=true&_rsc_segments=`,
    );
    expect(replay.status()).toBe(200);
    assertPprReplayStatus(
      { headers: new Headers(replay.headers()) },
      { outcome: "BYPASS", reason: "no-navigation-context" },
    );
  });

  test("stale SWR navigation replays the captured handler promise, top-level handles, and Meta", async ({
    page,
  }) => {
    const probe = crypto.randomUUID();
    const one = f.url(`/shell-cache/stale-replay/1?probe=${probe}`);
    const two = f.url(`/shell-cache/stale-replay/2?probe=${probe}`);
    const waitForPartialResponse = (pathname: string) =>
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === pathname && url.searchParams.has("_rsc_partial")
        );
      });
    await warmToHit(page.request, one);

    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    // Enter /2 through a real partial request without warming it. This pins the
    // bounded bypass signal and gives the /2 -> /1 fresh replay control.
    const bypassResponsePromise = waitForPartialResponse(
      "/shell-cache/stale-replay/2",
    );
    const clickPartials: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname === "/shell-cache/stale-replay/2" &&
        url.searchParams.get("probe") === probe &&
        url.searchParams.has("_rsc_partial") &&
        !isPrefetchRequest(request)
      ) {
        clickPartials.push(request.url());
      }
    });
    await page.evaluate((href) => {
      const link = document.createElement("a");
      link.href = href;
      link.dataset.testid = "shell-stale-replay-entry";
      link.textContent = "Enter stale replay fixture";
      document.body.append(link);
    }, two);
    const entryLink = testId(page, "shell-stale-replay-entry");
    let bypassResponse;
    if (production) {
      await entryLink.scrollIntoViewIfNeeded();
      bypassResponse = await bypassResponsePromise;
      expect(isPrefetchRequest(bypassResponse.request())).toBe(true);
      expect(bypassResponse.ok()).toBe(true);
      expect(await bypassResponse.finished()).toBeNull();
      await entryLink.click();
    } else {
      await entryLink.click();
      bypassResponse = await bypassResponsePromise;
      expect(isPrefetchRequest(bypassResponse.request())).toBe(false);
    }
    assertPprReplayStatus(
      { headers: new Headers(bypassResponse.headers()) },
      { outcome: "BYPASS", reason: "no-entry" },
    );
    await expect(testId(page, "shell-stale-replay-data")).toContainText(
      /^shell-stale-2-execution-\d+$/,
    );
    if (production) expect(clickPartials).toHaveLength(0);

    const freshResponsePromise = waitForPartialResponse(
      "/shell-cache/stale-replay/1",
    );
    await testId(page, "shell-stale-replay-1").click();
    const freshResponse = await freshResponsePromise;
    assertPprReplayStatus(
      { headers: new Headers(freshResponse.headers()) },
      { outcome: "HIT", freshness: "fresh" },
    );
    const capturedData = await testId(
      page,
      "shell-stale-replay-data",
    ).textContent();
    const capturedHandles = await testId(
      page,
      "shell-stale-replay-handles",
    ).textContent();
    expect(capturedData).toMatch(/^shell-stale-1-execution-\d+$/);
    expect(JSON.parse(capturedHandles!).flat(Infinity)).toEqual([
      { yo: "yo-1" },
      { asd: capturedData },
    ]);
    await expect(page).toHaveTitle(`Stale replay 1: ${capturedData}`);

    const returnToTwoPromise = waitForPartialResponse(
      "/shell-cache/stale-replay/2",
    );
    await testId(page, "shell-stale-replay-2").click();
    const returnToTwo = await returnToTwoPromise;
    const returnToTwoStatus = parsePprReplayStatus({
      headers: new Headers(returnToTwo.headers()),
    });
    // The first /2 visit schedules capture. This return can race that background
    // work; PPR5 separately pins that a later request eventually becomes a HIT.
    expect([
      { outcome: "BYPASS", reason: "no-entry" },
      { outcome: "HIT", freshness: "fresh" },
    ]).toContainEqual(returnToTwoStatus);
    await expect(testId(page, "shell-stale-replay-data")).toContainText(
      /^shell-stale-2-execution-\d+$/,
    );

    const aged = await page.request.get(
      f.url(
        `/shell-cache/__corrupt?target=${encodeURIComponent(one)}&mode=stale`,
      ),
    );
    expect(await aged.json()).toEqual({
      ok: true,
      found: true,
      segmentKeys: [
        `doc:${new URL(one).host}/shell-cache/stale-replay/1:id=1?probe=${probe}`,
      ],
    });
    await page.waitForTimeout(1_200);

    // Match the production race: a stale document HIT starts background
    // recapture, then the browser navigates to the same shell before that
    // handler promise settles. The partial response must consume the stale
    // generation rather than rerun the handler or wait for recapture.
    const staleDocument = await page.request.get(one, {
      headers: HTML_HEADERS,
    });
    assertShellStatus({ headers: new Headers(staleDocument.headers()) }, "HIT");

    const staleResponsePromise = waitForPartialResponse(
      "/shell-cache/stale-replay/1",
    );
    const startedAt = Date.now();
    await testId(page, "shell-stale-replay-1").click();
    const staleResponse = await staleResponsePromise;
    assertPprReplayStatus(
      { headers: new Headers(staleResponse.headers()) },
      { outcome: "HIT", freshness: "stale" },
    );
    await expect(testId(page, "shell-stale-replay-data")).toHaveText(
      capturedData!,
    );
    await expect(testId(page, "shell-stale-replay-handles")).toHaveText(
      capturedHandles!,
    );
    await expect(page).toHaveTitle(`Stale replay 1: ${capturedData}`);
    expect(Date.now() - startedAt).toBeLessThan(1_200);
  });

  // Issue #702: fizz OUTLINES any Suspense boundary over ~500 bytes (fallback
  // written inline first, content as a queued task; past progressiveChunkSize
  // the completed content is outline-DEFERRED at flush into an out-of-band
  // segment + $RC — all prelude bytes). This pins that outlined-but-READY
  // content bakes into the STORED shell: fizz's runnable work is microtask-
  // atomic relative to the capture's macrotask abort schedule (tracked-
  // postpones pings run on scheduleMicrotask; the quiesce hops and abort on
  // setTimeout), so ready content of any size flushes before the abort lands.
  //
  // Structural scar tissue (why the hole is a SLOT): the original reproducer
  // put the section under a route-level loading() + loader. That shape can
  // NEVER bake the section — LoaderResolver use()es the masked loader promise
  // ABOVE the whole route subtree, so at capture nothing below it renders,
  // and React postpones whole Suspense boundaries (the fallback owns the
  // boundary's DOM slot), so bytes inside the postponed boundary cannot ride
  // the prelude. Under loading(), the entire route body IS the hole by
  // doctrine; content that must bake belongs BESIDE the hole (slot/layout
  // chrome) — the layout-with-loaders playbook.
  test("large sync Suspense section bakes into the shell — outlined content flushes before the capture abort", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/outlined?probe=outlined");
    await warmToHit(request, url);

    // Byte PROVENANCE is the discriminator: the stored prelude ends at the
    // first </html> (splitPrelude); the resumed tail (holes + $RC + hydration
    // payload) streams after it. Baked = every row inside the prelude; the
    // broken shape baked only the fallback and re-streamed the section per
    // request (measured on a real storefront: ~2.7MB re-rendered per HIT).
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
    const html = await res.text();
    const { prelude, resumed } = splitPrelude(html);

    expect(prelude).toContain("Outlined row 0<");
    expect(prelude).toContain(`Outlined row ${OUTLINED_LAST_ROW}<`);
    expect(prelude).toContain('data-testid="outlined-static"');

    // The masked slot hole still postpones: the fallback is frozen into the
    // prelude, the live value (`outlined-badge-<seq>`, digit-anchored so the
    // fallback's own testid can't match) exists only in the per-request
    // resumed tail — masked-loader content must never bake.
    expect(prelude).toContain("outlined badge pending...");
    expect(prelude).not.toMatch(/outlined-badge-\d/);
    expect(resumed).toMatch(/outlined-badge-\d/);

    // The hole is LIVE: a second HIT serves the identical frozen prelude while
    // the badge seq advances (the loader re-ran for this request).
    const res2 = await request.get(url, { headers: HTML_HEADERS });
    expect(res2.headers()["x-rango-shell"]).toBe("HIT");
    const html2 = await res2.text();
    const second = splitPrelude(html2);
    expect(second.prelude).toBe(prelude);
    const seqOf = (body: string): number => {
      const m = /outlined-badge-(\d+)/.exec(body);
      expect(m, "resumed badge value present").toBeTruthy();
      return Number(m![1]);
    };
    expect(seqOf(second.resumed)).toBeGreaterThan(seqOf(resumed));
  });

  // --- Fragment splice (issue #700): a HIT tail emits stored snapshot
  // fragments VERBATIM into the hydration payload instead of re-serializing
  // the baked tree per request. On the wire the replayed segments travel as
  // __rangoFragment envelopes (string copy); the SSR resume pass and browser
  // hydration expand them through their own Flight deserializers. ---

  // Cold-graph absorber for the fragment assertions below: the capture's doc
  // segment record is written under waitUntil and pinned into the snapshot
  // only if it settles within the capture's write-settle window — on a COLD
  // dev module graph the first serialization outlasts it, storing a
  // snapshot-less entry whose HITs keep the full tail (no fast path, no
  // fragments) until TTL. Warming a sacrificial probe first compiles the
  // codec so the asserted probes' captures settle in time. Production builds
  // serialize in milliseconds and never need this.
  async function warmFragmentGraph(request: Page["request"]): Promise<void> {
    await warmToHit(request, f.url("/shell-cache?probe=fragwarmup"));
  }

  test("HIT hydration payload carries verbatim fragment envelopes; MISS carries none", async ({
    request,
  }) => {
    await warmFragmentGraph(request);
    const url = f.url("/shell-cache/outlined?probe=fragments");

    // First request: MISS — a fresh render serializes real elements, so no
    // envelope may appear anywhere in the document. Conditional on a genuine
    // MISS so a test RETRY (probe already warmed by attempt 1) stays valid.
    const miss = await request.get(url, { headers: HTML_HEADERS });
    expect(miss.status()).toBe(200);
    if (miss.headers()["x-rango-shell"] === "MISS") {
      expect(await miss.text()).not.toContain("__rangoFragment");
    }

    await warmToHit(request, url);

    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
    const { prelude, resumed } = splitPrelude(await res.text());

    // The envelope marker rides ONLY the resumed tail (the inlined hydration
    // payload); the frozen prelude HTML never carries it.
    expect(prelude).not.toContain("__rangoFragment");
    expect(resumed).toContain("__rangoFragment");

    // Payload completeness: the baked section's rows still reach the client
    // for hydration — inside the fragment strings, not as freshly
    // re-serialized element rows.
    expect(resumed).toContain(`Outlined row ${OUTLINED_LAST_ROW}`);
  });

  // Route choice: /shell-cache/slot-hole, deliberately. The fragment splice
  // requires the ARMED fast path (a snapshot-seeded doc record), and in dev
  // that depends on the capture's deferred doc-record write settling inside
  // the snapshot write-settle window — which slot-hole's lean tree does
  // deterministically, while /shell-cache's heavier chrome misses the window
  // in dev (pre-existing #695 behavior: those dev HITs keep the full tail)
  // and /shell-cache/outlined has a pre-existing dev-only render-counter
  // drift (hydration mismatches on main too, fragments or not). Not
  // exec-matrix: its test asserts exact module-counter deltas, and this
  // test's requests to the same route would race them.
  test("fragment-envelope HIT hydrates with zero errors and the slot hole stays live", async ({
    page,
  }) => {
    await warmFragmentGraph(page.request);
    const url = f.url("/shell-cache/slot-hole?probe=fraghydrate");
    await warmToHit(page.request, url);

    // Confirm this exact probe's HIT really is fragment-shaped before driving
    // the browser at it — the hydration guard below then proves the envelopes
    // are consumer-invisible.
    const res = await page.request.get(url, { headers: HTML_HEADERS });
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
    expect(await res.text()).toContain("__rangoFragment");

    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);
    await page.goto(url);
    await waitForHydration(page);

    await expect(testId(page, "shell-slot-home")).toHaveText(
      "Slot home static content",
    );
    // The masked slot hole stayed live: the badge value streamed in fresh
    // through the expanded-fragment shell.
    await expect(testId(page, "shell-badge-value")).toContainText(/badge-\d/);
  });

  test("a warm fragment prefetch expands its client chunk before the click", async ({
    page,
    request,
  }) => {
    await warmFragmentGraph(request);
    const targetPath = "/shell-cache/slot-hole?probe=fragment-prefetch-warm";
    await warmToHit(request, f.url(targetPath));

    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    const scriptResources = () =>
      page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => /\.[cm]?[jt]sx?$/.test(new URL(name).pathname)),
      );
    const beforePrefetch = new Set(await scriptResources());
    const partialRequests: string[] = [];
    page.on("request", (req) => {
      const requestUrl = new URL(req.url());
      if (
        requestUrl.pathname === "/shell-cache/slot-hole" &&
        requestUrl.searchParams.get("probe") === "fragment-prefetch-warm" &&
        requestUrl.searchParams.has("_rsc_partial")
      ) {
        partialRequests.push(req.url());
      }
    });
    const prefetchResponse = page.waitForResponse((response) => {
      const responseUrl = new URL(response.url());
      return (
        responseUrl.pathname === "/shell-cache/slot-hole" &&
        responseUrl.searchParams.get("probe") === "fragment-prefetch-warm" &&
        response.request().headers()["x-rango-prefetch"] === "1"
      );
    });

    await testId(page, "nav-ppr-fragment-prefetch-warm").hover();
    const response = await prefetchResponse;
    expect(response.request().headers()["x-rango-fragment-passthrough"]).toBe(
      "1",
    );
    expect(await response.text()).toContain("__rangoFragment");
    // Dev serves each client module separately, so fragment expansion is
    // directly visible as pre-click JS I/O. Production may fold the fixture's
    // client reference into the initial app chunk; the no-new-JS click check
    // below remains the observable contract there.
    if (!production) {
      await expect
        .poll(async () => (await scriptResources()).length, { timeout: 10_000 })
        .toBeGreaterThan(beforePrefetch.size);
    }
    const warmedResources = new Set(await scriptResources());

    await testId(page, "nav-ppr-fragment-prefetch-warm").click();
    await expect(testId(page, "shell-slot-home")).toHaveText(
      "Slot home static content",
    );
    expect(partialRequests).toHaveLength(1);
    expect(
      (await scriptResources()).filter((name) => !warmedResources.has(name)),
    ).toEqual([]);
  });

  test("an in-flight fragment prefetch is adopted without a second request", async ({
    page,
    request,
  }) => {
    await warmFragmentGraph(request);
    const targetPath =
      "/shell-cache/slot-hole?probe=fragment-prefetch-inflight";
    await warmToHit(request, f.url(targetPath));

    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    let releasePrefetch!: () => void;
    const holdPrefetch = new Promise<void>((resolve) => {
      releasePrefetch = resolve;
    });
    await page.route(
      (routeUrl) =>
        routeUrl.pathname === "/shell-cache/slot-hole" &&
        routeUrl.searchParams.get("probe") === "fragment-prefetch-inflight" &&
        routeUrl.searchParams.has("_rsc_partial"),
      async (route) => {
        await holdPrefetch;
        await route.continue();
      },
    );

    const partialRequests: string[] = [];
    page.on("request", (req) => {
      const requestUrl = new URL(req.url());
      if (
        requestUrl.pathname === "/shell-cache/slot-hole" &&
        requestUrl.searchParams.get("probe") === "fragment-prefetch-inflight" &&
        requestUrl.searchParams.has("_rsc_partial")
      ) {
        partialRequests.push(req.url());
      }
    });
    const prefetchStarted = page.waitForRequest((req) => {
      const requestUrl = new URL(req.url());
      return (
        requestUrl.pathname === "/shell-cache/slot-hole" &&
        requestUrl.searchParams.get("probe") === "fragment-prefetch-inflight" &&
        req.headers()["x-rango-prefetch"] === "1"
      );
    });
    const prefetchResponse = page.waitForResponse((response) => {
      const responseUrl = new URL(response.url());
      return (
        responseUrl.pathname === "/shell-cache/slot-hole" &&
        responseUrl.searchParams.get("probe") === "fragment-prefetch-inflight"
      );
    });

    await testId(page, "nav-ppr-fragment-prefetch-inflight").hover();
    await prefetchStarted;
    // Dispatch while the prefetch is held before response headers. The click
    // must adopt the registered inflight promise; it cannot consume a warm
    // cache entry because none exists yet.
    await testId(page, "nav-ppr-fragment-prefetch-inflight").dispatchEvent(
      "click",
    );
    releasePrefetch();
    const response = await prefetchResponse;
    expect(await response.text()).toContain("__rangoFragment");
    await expect(testId(page, "shell-slot-home")).toHaveText(
      "Slot home static content",
    );
    expect(partialRequests).toHaveLength(1);
  });

  test("partial replay HIT carries verbatim fragment envelopes; a context-less probe carries none", async ({
    request,
  }) => {
    // #700 extended to navigation: the same doc segment record that fragments
    // the document HIT tail now fragments the partial replay serve — the
    // navigation-client/prefetch decoders expand the envelopes client-side.
    await warmFragmentGraph(request);
    const url = f.url("/shell-cache/slot-hole?probe=fragnav");
    await warmToHit(request, url);

    const replay = await request.get(
      `${url}&_rsc_partial=true&_rsc_segments=`,
      {
        headers: {
          "X-RSC-Router-Client-Path": f.url("/"),
          "X-Rango-Fragment-Passthrough": "1",
        },
      },
    );
    expect(replay.status()).toBe(200);
    assertPprReplayStatus(
      { headers: new Headers(replay.headers()) },
      { outcome: "HIT", freshness: "fresh" },
    );
    const body = await replay.text();
    expect(body).toContain("__rangoFragment");
    // Payload completeness: the replayed content still reaches the client —
    // inside the fragment strings, not as re-serialized element rows.
    expect(body).toContain("Slot home static content");

    // Context-less probe (curl shape): the replay gate bypasses BEFORE the
    // fragment arming, so the fallback render serializes real elements — no
    // envelope may reach a consumer that cannot expand them.
    const probe = await request.get(`${url}&_rsc_partial=true&_rsc_segments=`);
    expect(probe.status()).toBe(200);
    expect(await probe.text()).not.toContain("__rangoFragment");
  });
}

test.describe("shell-cache (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runShellCacheSpec(f, false);
});

test.describe("shell-cache (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runShellCacheSpec(f, true);
});
