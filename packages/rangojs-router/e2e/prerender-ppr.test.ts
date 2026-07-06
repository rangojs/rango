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
