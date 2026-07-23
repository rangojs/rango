import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Progressive-enhancement header-preservation tests.
 *
 * When a form with a server action is submitted with JavaScript disabled, the
 * browser performs a native POST and the router re-renders the page as HTML.
 * The re-render is a synthetic GET request; before the fix it carried only
 * `accept: text/html`, dropping the original POST's Cookie/Authorization/custom
 * headers. A loader reading a request header therefore saw nothing under PE,
 * diverging from the JS action path.
 *
 * The fix copies the POST headers (minus content-type/content-length) onto the
 * GET re-render. The /pe-header fixture proves it: a loader reads the `pe-probe`
 * request cookie (which the browser sends automatically on the native POST) and
 * renders it. After a no-JS submit the re-rendered page must still show the
 * cookie value, matching the JS path.
 *
 * State lives in cookies, so a fresh per-test browser context starts clean and
 * parallel runs never interfere.
 */
function defineSpec(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`PE preserves request headers on re-render (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test.describe("with JavaScript disabled", () => {
      test.use({ javaScriptEnabled: false });
      if (mode === "build") test.setTimeout(120000);

      test("loader reads the original POST request cookie during the no-JS re-render", async ({
        page,
        context,
      }) => {
        // The browser sends this cookie on the native POST; the PE re-render
        // must carry it so the loader can read it.
        await context.addCookies([
          {
            name: "pe-probe",
            value: "probe-value-noscript",
            domain: "localhost",
            path: "/",
          },
        ]);

        await page.goto(f.url("/pe-header"));

        // Initial GET: the loader sees the cookie, and no submit has happened.
        await expect(testId(page, "pe-header-title")).toHaveText(
          "PE Header Preservation Test",
        );
        await expect(testId(page, "pe-header-probe")).toHaveText(
          "probe-value-noscript",
        );
        await expect(testId(page, "pe-header-submitted")).toHaveText("no");

        // Submit with JS disabled -> native POST -> PE re-render (HTML).
        await testId(page, "pe-header-submit").click();
        await page.waitForLoadState("domcontentloaded");

        // We got an HTML re-render, not an RSC stream.
        const content = await page.content();
        expect(content).toMatch(/<!DOCTYPE html>/i);

        // The action ran (its marker cookie is now set and read back), and the
        // loader STILL sees the original POST request cookie on the re-render.
        // Before the fix the re-render request dropped the Cookie header, so
        // both of these would have read empty/no-probe.
        await expect(testId(page, "pe-header-submitted")).toHaveText("yes");
        await expect(testId(page, "pe-header-probe")).toHaveText(
          "probe-value-noscript",
        );
      });
    });

    test.describe("with JavaScript enabled", () => {
      if (mode === "build") test.setTimeout(120000);

      test("loader reads the request cookie during the JS action re-render (parity)", async ({
        page,
        context,
      }) => {
        using _ = expectNoPageError(page);

        await context.addCookies([
          {
            name: "pe-probe",
            value: "probe-value-js",
            domain: "localhost",
            path: "/",
          },
        ]);

        await page.goto(f.url("/pe-header"));
        await waitForHydration(page);

        await expect(testId(page, "pe-header-probe")).toHaveText(
          "probe-value-js",
        );
        await expect(testId(page, "pe-header-submitted")).toHaveText("no");

        await testId(page, "pe-header-submit").click();

        // SPA update: action ran and the loader still observes the cookie.
        await expect(testId(page, "pe-header-submitted")).toHaveText("yes");
        await expect(testId(page, "pe-header-probe")).toHaveText(
          "probe-value-js",
        );
        await expect(page).toHaveURL(/\/pe-header/);
      });
    });
  });
}

defineSpec("dev");
defineSpec("build");
