import { test } from "@playwright/test";
import { runSlotRedirectTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * An intercept or parallel slot handler's redirect() redirects as a route
 * handler's does, on an action's revalidation (under loading()), a document
 * request, a client navigation and a refresh. Fixture:
 * test-app/src/urls/slot-redirect.tsx. Body:
 * tests/shared-e2e/src/slot-redirect-scenario.ts.
 */
function describeSlotRedirect(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`intercept and slot handler redirects (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runSlotRedirectTests({ url: (pathname) => f.url(pathname) });
  });
}

describeSlotRedirect("dev");
describeSlotRedirect("build");
