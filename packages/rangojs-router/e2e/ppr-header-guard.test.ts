import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * ppr header-write guard (issue #713).
 *
 * Doctrine: ppr is a document-scoped cache() — in any cached scenario ONLY
 * MIDDLEWARE writes headers.
 *
 * - handler ctx.headers.set on a ppr route -> deterministic error on every
 *   render (dev and prod), same guard family as the cache() boundary guard.
 * - loader cookies().set on a ppr route -> same guard, loader wording.
 * - POSITIVE CONTROL: middleware headers + Set-Cookie ride MISS and HIT
 *   responses alike (static value byte-equal, per-request value still
 *   advancing on HITs — middleware runs live, never replayed).
 * - POST-NEXT lane: route middleware writing AFTER `await next()` on a ppr
 *   route (header + cookies().set) lands on MISS and HIT — pins the
 *   middleware exemption's mechanism (the latch dies with the funnel scope;
 *   runWithStore never copies cachedHeaderScope).
 *
 * (ppr/cache() message-family EQUIVALENCE is pinned at the unit level —
 * cached-header-guard.test.ts — not re-asserted through a browser here.)
 */

const HTML_HEADERS = { Accept: "text/html" };

async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 10000 });
}

function runPprHeaderGuardSpec(
  f: ReturnType<typeof useFixture>,
  isDev: boolean,
) {
  test("handler ctx.headers.set on a ppr route errors deterministically (first and second GET)", async ({
    page,
  }) => {
    await page.goto(f.url("/ppr-header-guard/handler"));
    await waitForHydration(page);
    await expect(page.getByTestId("phg-error-page")).toBeVisible();
    if (isDev) {
      await expect(page.getByTestId("phg-error-message")).toContainText(
        "Set response headers in route middleware",
      );
      await expect(page.getByTestId("phg-error-message")).toContainText(
        "from a handler",
      );
    }

    // Second GET: still the error — deterministic, and no error shell was
    // cached (a poisoned HIT would serve the page without the boundary).
    await page.goto(f.url("/ppr-header-guard/handler"));
    await waitForHydration(page);
    await expect(page.getByTestId("phg-error-page")).toBeVisible();
  });

  test("handler header write never reaches the response; route never becomes a shell HIT", async ({
    request,
  }) => {
    for (let i = 0; i < 3; i++) {
      const res = await request.get(f.url("/ppr-header-guard/handler"), {
        headers: HTML_HEADERS,
      });
      expect(res.headers()["x-phg-handler"]).toBeUndefined();
      expect(res.headers()["x-rango-shell"]).not.toBe("HIT");
    }
  });

  test("loader cookies().set on a ppr route errors deterministically with the loader wording", async ({
    page,
  }) => {
    await page.goto(f.url("/ppr-header-guard/loader"));
    await waitForHydration(page);
    await expect(page.getByTestId("phg-error-page")).toBeVisible();
    if (isDev) {
      await expect(page.getByTestId("phg-error-message")).toContainText(
        "from a loader",
      );
      await expect(page.getByTestId("phg-error-message")).toContainText(
        "Set response headers in route middleware",
      );
    }
  });

  test("loader cookie write never reaches the response", async ({
    request,
  }) => {
    const res = await request.get(f.url("/ppr-header-guard/loader"), {
      headers: HTML_HEADERS,
    });
    expect(res.headers()["set-cookie"] ?? "").not.toContain("phg-loader");
  });

  test("middleware header + cookie ride MISS and HIT alike (live lane)", async ({
    request,
  }) => {
    const url = f.url("/ppr-header-guard/mw-live");

    // MISS: middleware header + cookie present.
    const miss = await request.get(url, { headers: HTML_HEADERS });
    expect(miss.status()).toBe(200);
    const missHeaders = miss.headers();
    expect(missHeaders["x-phg-mw"]).toBe("static-value");
    expect(missHeaders["x-phg-mw-seq"]).toBeTruthy();
    expect(missHeaders["set-cookie"]).toContain("phg_mw_session=live-cookie");

    await warmToHit(request, url);

    // HIT: byte-equal static header, cookie still present.
    const hit = await request.get(url, { headers: HTML_HEADERS });
    const hitHeaders = hit.headers();
    expect(hitHeaders["x-rango-shell"]).toBe("HIT");
    expect(hitHeaders["x-phg-mw"]).toBe(missHeaders["x-phg-mw"]);
    expect(hitHeaders["set-cookie"]).toContain("phg_mw_session=live-cookie");

    // Liveness: the per-request middleware value keeps advancing on HITs —
    // middleware executes on every request, it is not replayed from the shell.
    const hit2 = await request.get(url, { headers: HTML_HEADERS });
    expect(hit2.headers()["x-rango-shell"]).toBe("HIT");
    expect(hit2.headers()["x-phg-mw-seq"]).not.toBe(hitHeaders["x-phg-mw-seq"]);
  });

  test("post-next() middleware header + cookie land on MISS and HIT (latch dies with the funnel scope)", async ({
    request,
  }) => {
    const url = f.url("/ppr-header-guard/mw-post-next");

    // MISS: post-next writes ran AFTER the ppr render latched and unwound —
    // they must not throw and must reach the response.
    const miss = await request.get(url, { headers: HTML_HEADERS });
    expect(miss.status()).toBe(200);
    expect(miss.headers()["x-phg-post-next"]).toBe("1");
    expect(miss.headers()["set-cookie"]).toContain("phg_post_next=1");

    await warmToHit(request, url);

    // HIT: same post-next writes on the shell-HIT response.
    const hit = await request.get(url, { headers: HTML_HEADERS });
    expect(hit.headers()["x-rango-shell"]).toBe("HIT");
    expect(hit.headers()["x-phg-post-next"]).toBe("1");
    expect(hit.headers()["set-cookie"]).toContain("phg_post_next=1");
  });
}

// ============================================================================
// Dev
// ============================================================================

test.describe("ppr-header-guard", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runPprHeaderGuardSpec(f, true);
});

// ============================================================================
// Production
// ============================================================================

test.describe("ppr-header-guard (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runPprHeaderGuardSpec(f, false);
});
