import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * ppr header-write guard on workerd/KV (issue #713).
 *
 * Doctrine: ppr is a document-scoped cache() — in any cached scenario ONLY
 * MIDDLEWARE writes headers.
 *
 * - handler ctx.headers.set / loader cookies().set on a ppr route -> the
 *   unified guard errors deterministically on every render (dev and prod).
 * - POSITIVE CONTROL: middleware header + Set-Cookie ride MISS and HIT alike.
 * - STOREFRONT BASKET SHAPE: action POST rotates the basket cookie; the
 *   following GET is a shell HIT whose middleware still sees the cookie —
 *   session continuity through action POST -> GET(HIT).
 */

const HTML_HEADERS = { Accept: "text/html" };

/** Poll a URL until the shell cache reports HIT (background capture landed). */
async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 20000 });
}

function describePprHeaderGuard(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  const isDev = mode === "dev";

  test.describe(`ppr-header-guard (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("handler ctx.headers.set on a ppr route errors deterministically", async ({
      page,
    }) => {
      await page.goto(f.url("/ppr-header-guard"));
      await expect(page.getByTestId("cf-phg-error-page")).toBeVisible();
      if (isDev) {
        await expect(page.getByTestId("cf-phg-error-message")).toContainText(
          "Set response headers in route middleware",
        );
        await expect(page.getByTestId("cf-phg-error-message")).toContainText(
          "from a handler",
        );
      }

      // Second GET: still the error — deterministic, no error shell cached.
      await page.goto(f.url("/ppr-header-guard"));
      await expect(page.getByTestId("cf-phg-error-page")).toBeVisible();
    });

    test("handler header write never reaches the response; route never becomes a HIT", async ({
      request,
    }) => {
      for (let i = 0; i < 3; i++) {
        const res = await request.get(f.url("/ppr-header-guard"), {
          headers: HTML_HEADERS,
        });
        expect(res.headers()["x-cf-phg-handler"]).toBeUndefined();
        expect(res.headers()["x-rango-shell"]).not.toBe("HIT");
      }
    });

    test("loader cookies().set on a ppr route errors deterministically with the loader wording", async ({
      page,
      request,
    }) => {
      await page.goto(f.url("/ppr-header-guard/loader"));
      await expect(page.getByTestId("cf-phg-error-page")).toBeVisible();
      if (isDev) {
        await expect(page.getByTestId("cf-phg-error-message")).toContainText(
          "from a loader",
        );
      }

      const res = await request.get(f.url("/ppr-header-guard/loader"), {
        headers: HTML_HEADERS,
      });
      expect(res.headers()["set-cookie"] ?? "").not.toContain("cf-phg-loader");
    });

    test("middleware header + cookie ride MISS and HIT alike (live lane)", async ({
      request,
    }) => {
      const url = f.url("/ppr-mw-live?probe=mw-live");

      const miss = await request.get(url, { headers: HTML_HEADERS });
      expect(miss.status()).toBe(200);
      const missHeaders = miss.headers();
      expect(missHeaders["x-cf-phg-mw"]).toBe("static-value");
      expect(missHeaders["x-cf-phg-mw-req"]).toBeTruthy();
      expect(missHeaders["set-cookie"]).toContain(
        "cf_phg_mw_session=live-cookie",
      );

      await warmToHit(request, url);

      const hit = await request.get(url, { headers: HTML_HEADERS });
      const hitHeaders = hit.headers();
      expect(hitHeaders["x-rango-shell"]).toBe("HIT");
      // Byte-equal static middleware header on MISS and HIT.
      expect(hitHeaders["x-cf-phg-mw"]).toBe(missHeaders["x-cf-phg-mw"]);
      expect(hitHeaders["set-cookie"]).toContain(
        "cf_phg_mw_session=live-cookie",
      );

      // Liveness: the per-request middleware value differs between HITs —
      // middleware executes on every request, never replayed from the shell.
      const hit2 = await request.get(url, { headers: HTML_HEADERS });
      expect(hit2.headers()["x-rango-shell"]).toBe("HIT");
      expect(hit2.headers()["x-cf-phg-mw-req"]).not.toBe(
        hitHeaders["x-cf-phg-mw-req"],
      );
    });

    test("basket continuity: action POST -> GET(HIT) still sees the session cookie", async ({
      page,
    }) => {
      const url = f.url("/ppr-basket?probe=basket");

      // MISS: no basket cookie yet — middleware reflects 0.
      const miss = await page.goto(url);
      expect(miss?.headers()["x-cf-basket-count"]).toBe("0");

      // Warm the shell with the page's own cookie jar.
      await warmToHit(page.request, url);

      // On a HIT page, run the action: it rotates the basket cookie. Wait for
      // the live hole to resume before interacting — during the resume window
      // the frozen shell and the streamed tail can transiently coexist.
      await page.goto(url);
      await waitForHydration(page);
      await expect(testId(page, "cf-phg-hole-seq")).toBeVisible();
      await testId(page, "basket-add").click();
      await expect(testId(page, "basket-count")).toHaveText("1");

      // GET after the action: still a shell HIT, and the middleware sees the
      // rotated cookie per request — the session survives the cached shell.
      const afterAction = await page.request.get(url, {
        headers: HTML_HEADERS,
      });
      expect(afterAction.headers()["x-rango-shell"]).toBe("HIT");
      expect(afterAction.headers()["x-cf-basket-count"]).toBe("1");

      // Second increment keeps the continuity monotonic.
      await page.goto(url);
      await waitForHydration(page);
      await expect(testId(page, "cf-phg-hole-seq")).toBeVisible();
      await testId(page, "basket-add").click();
      await expect(testId(page, "basket-count")).toHaveText("2");
      const afterSecond = await page.request.get(url, {
        headers: HTML_HEADERS,
      });
      expect(afterSecond.headers()["x-rango-shell"]).toBe("HIT");
      expect(afterSecond.headers()["x-cf-basket-count"]).toBe("2");
    });
  });
}

describePprHeaderGuard("dev");
describePprHeaderGuard("build");
