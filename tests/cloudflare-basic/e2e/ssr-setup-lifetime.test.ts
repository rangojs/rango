import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

function defineSsrSetupLifetimeSuite(mode: "dev" | "build"): void {
  const title =
    mode === "build"
      ? "SSR setup request lifetime (production)"
      : "SSR setup request lifetime";

  test.describe(title, () => {
    const f = useFixture({
      root: ".",
      mode,
      isolatedServer: true,
      // A document readiness probe would settle the memoized SSR import before
      // the redirect under test. Keep the workerd isolate cold with a response
      // route, which short-circuits before startSSRSetup().
      readyPath: "/api/health",
    });

    test("a document redirect cannot poison SSR setup for the next request", async ({
      request,
    }) => {
      const redirect = await request.get(f.url("/?ssr-setup-redirect=1"), {
        headers: { Accept: "text/html" },
        maxRedirects: 0,
      });
      expect([301, 302, 303, 307, 308]).toContain(redirect.status());
      expect(redirect.headers().location).toBe("/about");

      const document = await request.get(f.url("/"), {
        headers: { Accept: "text/html" },
      });
      expect(document.status()).toBe(200);
      expect(await document.text()).toContain("Welcome to RSC Router");
    });
  });
}

defineSsrSetupLifetimeSuite("dev");
defineSsrSetupLifetimeSuite("build");
