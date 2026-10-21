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
    const f = useFixture({ root: ".", mode });
    runActionOwnExportTests({
      url: (pathname) => f.url(pathname),
      action: {
        path: "/rw/shop",
        submit: '[data-testid="rw-save"]',
        name: "rwSaveCart",
      },
    });
  });
}

// Dev resolves each server-reference module to its namespace, which has no prototype.
describeActionOwnExport("dev");
describeActionOwnExport("build");
