import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

function defineSsrSetupLifetimeSuite(
  title: string,
  mode: "dev" | "build",
): void {
  const suiteTitle = mode === "build" ? `${title} (production)` : title;
  test.describe(suiteTitle, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
      isolatedServer: true,
    });

    test("an HTML redirect cannot poison SSR setup for the next document", async ({
      request,
    }) => {
      const redirect = await request.get(f.url("/cache-status/redirect"), {
        headers: { Accept: "text/html" },
        maxRedirects: 0,
      });
      expect([301, 302, 303, 307, 308]).toContain(redirect.status());

      const document = await request.get(f.url("/"), {
        headers: { Accept: "text/html" },
      });
      expect(document.status()).toBe(200);
      expect(await document.text()).toContain("Products");
    });
  });
}

defineSsrSetupLifetimeSuite("SSR setup request lifetime", "dev");
defineSsrSetupLifetimeSuite("SSR setup request lifetime", "build");
