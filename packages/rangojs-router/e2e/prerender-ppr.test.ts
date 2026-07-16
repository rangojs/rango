import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  expectNoPageError,
  expectNoReload,
  testId,
  waitForHydration,
} from "./helper";
import { guardHydrationErrors } from "@shared/e2e";
import { assertPprReplayStatus } from "@rangojs/router/testing/e2e";

// Prerender + ppr COMPOSITION (docs/design/shell-fast-path.md): one route
// carries both a build-time prerendered handler (trie pr:true) and the ppr
// shell option. The capture's match hits the prerender store, so the
// build-time segments bake into the frozen prelude and the loader (behind
// loading(), the live lane) is masked into a hole; every HIT replays the
// prerendered segments through the same store hit and re-runs the loader
// fresh. The Prerender handler never executes at serve — production evicts
// it to a stub; dev serves the memoized /__rsc_prerender payload.
//
// Fixture: /pp/:slug (test-app/src/urls/prerender.tsx) — two prerendered
// slugs (alpha, beta), PrerenderPprSeqLoader seq advances per execution.

const HTML_HEADERS = { Accept: "text/html" };

async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 15000 });
}

/** Split a document body at the frozen-prelude boundary (ends at </html>). */
function splitPrelude(html: string): { prelude: string; resumed: string } {
  const preludeEnd = html.indexOf("</html>");
  expect(preludeEnd).toBeGreaterThan(-1);
  return {
    prelude: html.slice(0, preludeEnd),
    resumed: html.slice(preludeEnd),
  };
}

function readSeq(html: string): number {
  const match = html.match(/pp-seq: (\d+)/);
  expect(match, "live seq present in the document").toBeTruthy();
  return Number(match![1]);
}

function runPrerenderPprSpec(f: Fixture): void {
  // These action assertions intentionally target the route's action-only
  // revalidation opt-out. Default Passthrough revalidation replaces this client
  // boundary with the live handler and discards its local useActionState result.
  const expectPrerenderAction = async (page: Page): Promise<void> => {
    const submit = testId(page, "prerender-ppr-action-submit");
    await expect(testId(page, "prerender-ppr-action-result")).toHaveCount(0);
    await submit.click();
    await expect(submit).toHaveText("Submitting...");
    await expect(testId(page, "prerender-ppr-action-fallback")).toBeVisible();
    await expect(testId(page, "ppp-source")).toHaveText("baked");
    await expect(testId(page, "prerender-ppr-action-result")).toHaveText(
      "prerender-ppr-action:from-client",
    );
    await expect(submit).toHaveText("Submit prerender action");
    await expect(testId(page, "ppp-source")).toHaveText("baked");
  };

  test("Passthrough Prerender+ppr document HIT streams with action revalidation opted out", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);
    const url = f.url("/ppp/baked");
    await warmToHit(page.request, url);

    const response = await page.goto(url);
    expect(response?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForHydration(page);
    await using ___ = await expectNoReload(page);
    await expect(testId(page, "ppp-source")).toHaveText("baked");
    await expectPrerenderAction(page);
  });

  test("Prerender-store partial navigation streams a client-imported action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await using ___ = await expectNoReload(page);
    const partialResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/ppp/baked" && url.searchParams.has("_rsc_partial")
      );
    });

    await testId(page, "nav-prerender-ppr-action").click();
    const partialResponse = await partialResponsePromise;
    assertPprReplayStatus(
      { headers: new Headers(partialResponse.headers()) },
      { outcome: "BYPASS", reason: "prerender-store" },
    );
    await expect(testId(page, "ppp-source")).toHaveText("baked");
    await expectPrerenderAction(page);
  });

  test("MISS serves the prerendered content live, then the route flips to HIT", async ({
    request,
  }) => {
    const url = f.url("/pp/alpha?probe=miss");
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("MISS");
    const html = await res.text();
    expect(html).toContain("Prerendered shell content for alpha");
    expect(html).toContain("pp-seq:");
    await warmToHit(request, url);
  });

  test("HIT: prerendered segments are the frozen prelude; the loader streams into the hole", async ({
    request,
  }) => {
    const url = f.url("/pp/alpha?probe=hit");
    await warmToHit(request, url);

    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
    const { prelude, resumed } = splitPrelude(await res.text());

    // Build-time content is prelude material.
    expect(prelude).toContain("Prerendered shell content for alpha");
    // The loader is a hole: fallback frozen in the prelude, value resumed.
    expect(prelude).toContain("Loading pp seq...");
    expect(prelude).not.toContain("pp-seq:");
    expect(resumed).toContain("pp-seq:");
  });

  test("loader liveness across HITs: seq advances per request while the shell replays", async ({
    request,
  }) => {
    const url = f.url("/pp/alpha?probe=live");
    await warmToHit(request, url);

    const first = await request.get(url, { headers: HTML_HEADERS });
    expect(first.headers()["x-rango-shell"]).toBe("HIT");
    const seq1 = readSeq(await first.text());

    const second = await request.get(url, { headers: HTML_HEADERS });
    expect(second.headers()["x-rango-shell"]).toBe("HIT");
    const seq2 = readSeq(await second.text());

    expect(seq2).toBe(seq1 + 1);
  });

  test("partial navigation is served from the prerender store and reports BYPASS; reason=prerender-store", async ({
    request,
  }) => {
    // The prerender short-circuit means a Prerender()+ppr capture never
    // records a doc segment record, so navigation replay could never seed —
    // the old flow spent two getShell reads to misreport
    // `no-segment-snapshot`. The gate now decides before any read; the
    // partial itself still serves from build-time segments.
    const url = f.url("/pp/alpha?probe=partial-nav");
    await warmToHit(request, url);

    const replay = await request.get(
      `${url}&_rsc_partial=true&_rsc_segments=`,
      { headers: { "X-RSC-Router-Client-Path": f.url("/") } },
    );
    expect(replay.status()).toBe(200);
    expect(replay.headers()["x-rango-ppr-replay"]).toBe(
      "BYPASS; reason=prerender-store",
    );
    const body = await replay.text();
    // Build-time segments supplied the partial match.
    expect(body).toContain("Prerendered shell content for alpha");
    // Fragment splice (#700) engages on the prerender-store partial lane too:
    // the baked segments ride as verbatim envelopes (cache-lookup's store
    // branch), expanded client-side exactly like doc-record replays.
    expect(body).toContain("__rangoFragment");
  });

  test("passthrough param with a baked artifact reports prerender-store; a live param keeps replay", async ({
    request,
  }) => {
    // /ppp/:slug is Passthrough(Prerender()) + ppr: the trie marks the route
    // pr:true for EVERY param, but only "baked" holds an artifact. The gate
    // probes the store instead of trusting the flag — otherwise the live
    // params would permanently misreport `prerender-store`, skip eligible
    // shells, and never schedule the heal capture.
    const bakedUrl = f.url("/ppp/baked?probe=ppp-baked");
    await warmToHit(request, bakedUrl);
    const bakedReplay = await request.get(
      `${bakedUrl}&_rsc_partial=true&_rsc_segments=`,
      { headers: { "X-RSC-Router-Client-Path": f.url("/") } },
    );
    expect(bakedReplay.status()).toBe(200);
    expect(bakedReplay.headers()["x-rango-ppr-replay"]).toBe(
      "BYPASS; reason=prerender-store",
    );
    const bakedBody = await bakedReplay.text();
    // Build-time segments supplied the partial: the BAKED handler's source
    // marker, never the live Passthrough handler's execution stamp.
    expect(bakedBody).toContain("PPP content for baked");
    expect(bakedBody).toContain("baked");
    expect(bakedBody).not.toContain("ppp-exec-");

    // Live param: the document warm-up captured the shell (live render, so
    // the doc segment record was recorded), and the partial navigation
    // replays it — the exact outcome the pr-flag gate used to make
    // impossible.
    const liveUrl = f.url("/ppp/live-one?probe=ppp-live");
    await warmToHit(request, liveUrl);
    const liveReplay = await request.get(
      `${liveUrl}&_rsc_partial=true&_rsc_segments=`,
      { headers: { "X-RSC-Router-Client-Path": f.url("/") } },
    );
    expect(liveReplay.status()).toBe(200);
    expect(liveReplay.headers()["x-rango-ppr-replay"]).toBe(
      "HIT; freshness=fresh",
    );
    const liveBody = await liveReplay.text();
    // The LIVE Passthrough handler rendered the capture this replay serves.
    expect(liveBody).toContain("PPP content for live-one");
    expect(liveBody).toContain("live");
    expect(liveBody).toContain("ppp-exec-");

    // The action-only revalidation opt-out must defer on navigation. A hard
    // false here would incorrectly retain live-one for this same-route param
    // change.
    const nextLiveUrl = f.url("/ppp/live-two?probe=ppp-live-next");
    const nextLive = await request.get(
      `${nextLiveUrl}&_rsc_partial=true&_rsc_segments=`,
      { headers: { "X-RSC-Router-Client-Path": liveUrl } },
    );
    expect(nextLive.status()).toBe(200);
    expect(await nextLive.text()).toContain("PPP content for live-two");
  });

  // Fragment splice (issue #700) on the Prerender+ppr composition: the HIT
  // tail serves its segments from the PRERENDER STORE (the lookup runs before
  // the cache scope), so the splice must engage there too — the hydration
  // payload carries the stored fragments verbatim (__rangoFragment envelopes)
  // instead of re-serializing the prerendered tree per request.
  test("HIT payload carries verbatim fragment envelopes (prerender-store splice)", async ({
    request,
  }) => {
    const url = f.url("/pp/alpha?probe=fragments");
    await warmToHit(request, url);

    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
    const { prelude, resumed } = splitPrelude(await res.text());

    expect(prelude).not.toContain("__rangoFragment");
    expect(resumed).toContain("__rangoFragment");
    // Payload completeness: the prerendered content still reaches the client
    // for hydration, inside the fragment strings.
    expect(resumed).toContain("Prerendered shell content for alpha");
  });

  // ---------------------------------------------------------------------
  // Producer B (#699): the shell entry is produced at BUILD time (dev: on
  // demand via /__rsc_shell), so the FIRST request already HITs. Build
  // entries cover the BARE pathname only — the ?probe= URLs above carry a
  // search string and keep exercising the runtime-capture lanes untouched.
  // Bare-path usage is partitioned across tests (fullyParallel-safe):
  // beta = first-request assertion, alpha = liveness; eviction has its own
  // route + tag (/pp-evict/gamma) so its updateTag cannot blast these; the
  // "warm" slug below absorbs the cold-graph cost (dev: the on-demand
  // capture compiles the temp SSR graph on first use) so the strict
  // first-request assertions never race CI cold-start physics.
  // ---------------------------------------------------------------------

  test.beforeAll(async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await warmToHit(ctx as unknown as Page["request"], f.url("/pp/warm"));
    } finally {
      await ctx.dispose();
    }
  });

  test("build-time shell: the FIRST request serves x-rango-shell: HIT with the frozen prelude", async ({
    request,
  }) => {
    const res = await request.get(f.url("/pp/beta"), {
      headers: HTML_HEADERS,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
    const { prelude, resumed } = splitPrelude(await res.text());
    expect(prelude).toContain("Prerendered shell content for beta");
    expect(prelude).toContain("Loading pp seq...");
    expect(prelude).not.toContain("pp-seq:");
    expect(resumed).toContain("pp-seq:");
  });

  test("build-time shell: loaders stay live across baked-entry HITs (seq advances)", async ({
    request,
  }) => {
    const url = f.url("/pp/alpha");
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
    const url = f.url("/pp-evict/gamma");
    const baked = await request.get(url, { headers: HTML_HEADERS });
    expect(baked.headers()["x-rango-shell"]).toBe("HIT");
    expect(await baked.text()).toContain("Evictable shell content for gamma");

    // Awaitable invalidation (cache-tag fixture endpoint): the tag marker
    // lands before the response, so the next read is deterministically MISS —
    // the baked entry is immutable, but the marker comparison rejects it.
    const invalidate = await request.get(
      f.url("/cache-tag-test/invalidate/pp-evict-shell"),
    );
    expect(invalidate.status()).toBe(200);

    const evicted = await request.get(url, { headers: HTML_HEADERS });
    expect(evicted.headers()["x-rango-shell"]).toBe("MISS");

    // Producer A takes over: the MISS scheduled a runtime capture that
    // stores a runtime entry (the runtime store is read before the manifest).
    await warmToHit(request, url);
  });

  test("build ctx.dynamic skips the baked shell; runtime capture can still own the route", async ({
    request,
  }) => {
    const url = f.url("/pp-build-dynamic/delta");
    const first = await request.get(url, { headers: HTML_HEADERS });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-shell"]).toBe("MISS");
    expect(await first.text()).toContain(
      "Build-dynamic shell content for delta",
    );

    await warmToHit(request, url);

    const hit = await request.get(url, { headers: HTML_HEADERS });
    expect(hit.headers()["x-rango-shell"]).toBe("HIT");
    const { prelude, resumed } = splitPrelude(await hit.text());
    expect(prelude).toContain("Build-dynamic shell content for delta");
    expect(prelude).toContain("Loading pp seq...");
    expect(resumed).toContain("pp-seq:");
  });

  test("runtime ctx.dynamic keeps the route off the PPR shell axis (never captures/serves a shell)", async ({
    request,
  }) => {
    // The route's middleware calls ctx.dynamic() unconditionally, so the request
    // never takes the PPR shell axis: no x-rango-shell header on any request, and
    // the 1s window between the two requests would have surfaced a HIT if a
    // capture had been scheduled. dynamic() scopes to the SHELL only — because
    // this is a Prerender() route, the body itself is the build-baked B-segment
    // replayed at runtime (dynamic() does not disable that), which is the
    // "normal" (non-shell) render path for a prerendered route.
    const url = f.url("/pp-runtime-dynamic/omega");
    const first = await request.get(url, { headers: HTML_HEADERS });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-shell"]).toBeUndefined();
    expect(await first.text()).toContain(
      "Runtime-dynamic shell content for omega",
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const second = await request.get(url, { headers: HTML_HEADERS });
    expect(second.status()).toBe(200);
    // Still no shell after the capture window: dynamic() suppressed scheduling.
    expect(second.headers()["x-rango-shell"]).toBeUndefined();
    expect(await second.text()).toContain(
      "Runtime-dynamic shell content for omega",
    );
  });

  test("per-param shells: both prerendered slugs HIT independently with their own content", async ({
    request,
  }) => {
    const alphaUrl = f.url("/pp/alpha?probe=params");
    const betaUrl = f.url("/pp/beta?probe=params");
    await warmToHit(request, alphaUrl);
    await warmToHit(request, betaUrl);

    const alpha = await (
      await request.get(alphaUrl, { headers: HTML_HEADERS })
    ).text();
    const beta = await (
      await request.get(betaUrl, { headers: HTML_HEADERS })
    ).text();

    expect(splitPrelude(alpha).prelude).toContain(
      "Prerendered shell content for alpha",
    );
    expect(splitPrelude(beta).prelude).toContain(
      "Prerendered shell content for beta",
    );
    expect(splitPrelude(alpha).prelude).not.toContain("for beta");
  });
}

test.describe("prerender-ppr (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runPrerenderPprSpec(f);
});

test.describe("prerender-ppr (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runPrerenderPprSpec(f);
});

// ---------------------------------------------------------------------
// Dev boot-race readiness (#719 P2/P3). These exercise the dev /__rsc_shell
// endpoint + client re-poll DIRECTLY, on their OWN isolated servers with no
// warm-up slug (the warmToHit beforeAll above masks the boot window). There is
// NO production sibling: production serves the first-request HIT from a build
// manifest with no /__rsc_shell endpoint, no temp server, and no re-poll loop —
// covered by the (production) describe above. A dev-only mechanism has no
// production counterpart to add (hard-rule dev+prod pairing, N/A justified).
// ---------------------------------------------------------------------

test.describe("prerender-ppr dev readiness: injected boot-race (#719)", () => {
  // Deterministic regression guard: RANGO_E2E_INJECT_SHELL_NOTREADY makes the
  // endpoint emit ONE reopt-class NOT-READY per pathname through the REAL
  // classifier before serving, so the read-through's re-poll runs end-to-end
  // (a natural cold race settles too fast on quick machines to guard this). The
  // FIRST request to a virgin slug must still recover to x-rango-shell: HIT.
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { RANGO_E2E_INJECT_SHELL_NOTREADY: "1" } },
  });

  test("injected reopt NOT-READY: the FIRST request re-polls to HIT", async ({
    request,
  }) => {
    const res = await request.get(f.url("/pp/alpha"), {
      headers: HTML_HEADERS,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  });
});

test.describe("prerender-ppr dev readiness: cold first request (#719)", () => {
  // Natural cold path (weak guard per #719: a fast machine can settle before the
  // first servable request). A virgin Prerender+ppr URL as the literal FIRST
  // request on a fresh server — HIT on request one, or a MISS that heals to HIT
  // inside the readiness window. Proves the endpoint -> capture -> client path
  // works cold end-to-end.
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("cold virgin route: first request HITs (or heals within the readiness window)", async ({
    request,
  }) => {
    const url = f.url("/pp/beta");
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    if (res.headers()["x-rango-shell"] !== "HIT") {
      await warmToHit(request, url);
    }
  });
});
