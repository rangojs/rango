import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

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
