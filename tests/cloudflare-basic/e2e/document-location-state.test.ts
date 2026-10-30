import { test } from "@playwright/test";
import { runDocumentLocationStateTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * Location state on document responses (#1330): a page load, a document
 * redirect and no-JS form posts. Body:
 * tests/shared-e2e/src/document-location-state-scenario.ts.
 */
function describeDocumentLocationState(mode: "dev" | "build") {
  test.describe(`document location state (${mode === "build" ? "production" : "dev"})`, () => {
    const f = useFixture({ root: ".", mode });
    runDocumentLocationStateTests({ url: (pathname) => f.url(pathname) });
  });
}

describeDocumentLocationState("dev");
describeDocumentLocationState("build");
