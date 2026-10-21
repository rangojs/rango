import { test } from "@playwright/test";
import { runActionOwnExportTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A request naming an action by an export its module does not own is
 * answered as a missing export is. Body:
 * tests/shared-e2e/src/action-own-export-scenario.ts.
 */
function describeActionOwnExport(mode: "dev" | "build") {
  test.describe(`action own export (${mode === "build" ? "production" : "dev"})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runActionOwnExportTests({
      url: (pathname) => f.url(pathname),
      action: {
        path: "/product/product-a",
        submit: '[data-testid="add-to-cart-btn"]',
        name: "addToCartWithResult",
      },
    });
  });
}

// Dev resolves each server-reference module to its namespace, which has no prototype.
describeActionOwnExport("dev");
describeActionOwnExport("build");
