import { test } from "@playwright/test";
import { expectStreamedBoundariesAdopted } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError } from "./helper";

// Cloudflare counterpart of packages/rangojs-router/e2e/streamed-boundary-
// adoption.test.ts. /suspense-demo/gated has two boundaries that resolve after
// hydration: the route loading() (stats read, 400ms) and the report card's
// local Suspense (2000ms).

function defineSuite(mode: "dev" | "build") {
  // Title DERIVED from mode so the `(production)` bucket tag can never drift.
  const title = `Streamed boundary adoption${mode === "build" ? " (production)" : ""}`;

  test.describe(title, () => {
    const f = useFixture({ root: ".", mode });

    test("boundaries resolving after hydration adopt the streamed server HTML", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await expectStreamedBoundariesAdopted(page, {
        url: f.url("/suspense-demo/gated"),
        mode,
        contentTestIds: ["sd-stats", "sd-report"],
      });
    });
  });
}

defineSuite("dev");
defineSuite("build");
