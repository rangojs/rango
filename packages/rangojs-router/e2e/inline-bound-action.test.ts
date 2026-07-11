import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

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
  }).toPass({ timeout: 10_000 });
}

async function expectBoundActionRoundTrip(page: Page): Promise<void> {
  await expect(testId(page, "inline-bound-action-page")).toBeVisible();
  const rendered = await testId(
    page,
    "inline-bound-action-rendered-captured",
  ).textContent();
  const capturedValue = rendered!.replace(/^rendered:/, "");
  expect(capturedValue).toMatch(/^server-token-/);

  await expect(testId(page, "inline-bound-action-captured")).toHaveText(
    "captured:none",
  );
  await testId(page, "inline-bound-action-submit").click();
  await expect(testId(page, "inline-bound-action-captured")).toHaveText(
    `captured:${capturedValue}`,
  );
  await expect(testId(page, "inline-bound-action-submitted")).toHaveText(
    "submitted:from-client",
  );
}

function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`inline bound action (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("closure-captured render-scope value round-trips through the action", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/inline-bound-action"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);

      await expectBoundActionRoundTrip(page);
    });

    test("runtime shell HIT preserves an embedded bound action", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const url = f.url("/inline-bound-action?probe=ppr-hit");
      await warmToHit(page.request, url);

      const response = await page.goto(url);
      expect(response?.headers()["x-rango-shell"]).toBe("HIT");
      await waitForHydration(page);
      await using __ = await expectNoReload(page);
      await expectBoundActionRoundTrip(page);
    });

    test("partial PPR navigation preserves an embedded bound action", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await warmToHit(
        page.request,
        f.url("/inline-bound-action?probe=ppr-nav"),
      );

      await page.goto(f.url("/"));
      await waitForHydration(page);
      await using __ = await expectNoReload(page);
      await testId(page, "nav-ppr-inline-action").click();
      await expect(page).toHaveURL(/inline-bound-action\?probe=ppr-nav$/);
      await expectBoundActionRoundTrip(page);
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
