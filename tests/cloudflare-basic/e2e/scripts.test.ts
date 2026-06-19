import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Script handle + <Scripts/> renderer under the Cloudflare preset (router.fetch).
 * Verifies the custom Document's two <Scripts/> sites render the inline head +
 * body scripts pushed by the route AND that they execute, in both dev and the
 * production build. (Nonce application is covered by tests/vite-rsc-demo, which
 * configures a nonceProvider + enforced CSP; cloudflare-basic configures no
 * nonceProvider, so the router mints no nonce here — see rsc/handler.ts.)
 */
function describeScripts(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`scripts (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("renders + executes inline head and body scripts via <Scripts/>", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/scripts-demo"));
      await waitForHydration(page);
      await expect(testId(page, "scripts-demo-page")).toBeVisible();

      // Both inline scripts were rendered into the document and executed.
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __cfHeadScript?: boolean }).__cfHeadScript,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __cfBodyScript?: boolean }).__cfBodyScript,
        ),
      ).toBe(true);
    });
  });
}

describeScripts("dev");
describeScripts("build");
