import { test } from "@playwright/test";
import { runSsrFalseFormTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A no-script document of a clientUrls() route whose ssr: false loader feeds
 * a useActionState form under an inline <Suspense> has the form whole
 * (#1138). Body: tests/shared-e2e/src/ssr-false-form-scenario.ts.
 */
test.describe("clientUrls ssr: false form", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runSsrFalseFormTests({
    url: (pathname) => f.url(pathname),
    path: "/client-urls-ssr-false-form",
  });
});

test.describe("clientUrls ssr: false form (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runSsrFalseFormTests({
    url: (pathname) => f.url(pathname),
    path: "/client-urls-ssr-false-form",
  });
});
