import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";
import { guardHydrationErrors } from "@shared/e2e";
import { assertPprReplayStatus } from "@rangojs/router/testing/e2e";

// Case (b) coverage: an inline `"use server"` action DEFINED INSIDE a server
// component that CLOSES OVER a render-scope value and is passed as a prop to a
// client component. Closing over the value makes plugin-rsc treat it as a bound
// argument: the server emits
//   registerServerReference(fn, id, name).bind(null, encryptActionBoundArgs([captured]))
// and the hoisted fn takes the encrypted blob as its first param (decrypted via
// decryptActionBoundArgs at invoke time). The client never sees the captured
// value, so a correct round-trip proves bound-arg serialization end to end.
// This is the path most exposed to a transformHoistInlineDirective refactor in a
// future @vitejs/plugin-rsc bump. Dev + production.
// Runtime PPR is intentionally covered separately from the build-time
// Static/Prerender replay blocked in #584 on plugin-rsc #1246: shell HIT and
// partial-navigation replay must not inherit that external dependency.

const HTML_HEADERS = { Accept: "text/html" };

async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const response = await request.get(url, { headers: HTML_HEADERS });
    expect(response.status()).toBe(200);
    expect(response.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 20_000 });
}

async function waitForShellHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    { timeout: 20_000 },
  );
}

async function expectBoundActionStreamsWhilePageHolePending(
  page: Page,
): Promise<void> {
  const root = page.locator('[data-testid="inline-bound-action-page"]:visible');
  await expect(root).toBeVisible();
  const rendered = await root
    .locator('[data-testid="inline-bound-action-rendered-captured"]')
    .textContent();
  const capturedValue = rendered!.replace(/^rendered:/, "");
  expect(capturedValue).toMatch(/^server-token-/);

  const pageFallback = root.locator(
    '[data-testid="inline-bound-page-hole-fallback"]',
  );
  const submit = root.locator('[data-testid="inline-bound-action-submit"]');
  await expect(pageFallback).toBeVisible();
  await expect(
    root.locator('[data-testid="inline-bound-action-captured"]'),
  ).toHaveText("captured:none");

  await submit.click();
  await expect(submit).toHaveText("Processing...");
  await expect(
    root.locator('[data-testid="inline-bound-action-stream-fallback"]'),
  ).toBeVisible();
  await expect(pageFallback).toBeVisible();

  await expect(
    root.locator('[data-testid="inline-bound-action-stream-result"]'),
  ).toHaveText(`completed:${capturedValue}:from-client`, { timeout: 5_000 });
  await expect(
    root.locator('[data-testid="inline-bound-action-captured"]'),
  ).toHaveText(`captured:${capturedValue}`);
  await expect(
    root.locator('[data-testid="inline-bound-action-submitted"]'),
  ).toHaveText("submitted:from-client");

  // The action's own streamed result completes before the unrelated page hole.
  await expect(pageFallback).toBeVisible();
  await expect(
    root.locator('[data-testid="inline-bound-page-hole-result"]'),
  ).toHaveText("Page hole resolved", { timeout: 10_000 });
}

function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`inline bound action (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("document MISS streams a bound action while a page hole is pending", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      using __ = guardHydrationErrors(page);
      const url = f.url(
        `/inline-bound-action?probe=ppr-miss-action-stream-${crypto.randomUUID()}`,
      );

      const response = await page.goto(url, { waitUntil: "commit" });
      expect(response?.headers()["x-rango-shell"]).toBe("MISS");
      await waitForShellHydration(page);
      await using ___ = await expectNoReload(page);

      await expectBoundActionStreamsWhilePageHolePending(page);
    });

    test("document HIT streams a bound action while a page hole is pending", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      using __ = guardHydrationErrors(page);
      const url = f.url("/inline-bound-action?probe=ppr-hit-action-stream");
      await warmToHit(page.request, url);

      const response = await page.goto(url, { waitUntil: "commit" });
      expect(response?.headers()["x-rango-shell"]).toBe("HIT");
      await waitForShellHydration(page);
      await using ___ = await expectNoReload(page);
      await expectBoundActionStreamsWhilePageHolePending(page);
    });

    test("partial PPR replay streams a bound action while a page hole is pending", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      using __ = guardHydrationErrors(page);
      await warmToHit(
        page.request,
        f.url("/inline-bound-action?probe=ppr-nav"),
      );

      await page.goto(f.url("/"));
      await waitForHydration(page);
      await using ___ = await expectNoReload(page);
      const partialResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/inline-bound-action" &&
          url.searchParams.has("_rsc_partial")
        );
      });
      await testId(page, "nav-ppr-inline-action").click();
      const partialResponse = await partialResponsePromise;
      assertPprReplayStatus(
        { headers: new Headers(partialResponse.headers()) },
        { outcome: "HIT", freshness: "fresh" },
      );
      await expect(page).toHaveURL(/inline-bound-action\?probe=ppr-nav$/);
      await expectBoundActionStreamsWhilePageHolePending(page);
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
