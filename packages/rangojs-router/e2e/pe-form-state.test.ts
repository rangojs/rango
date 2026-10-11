import { test } from "@playwright/test";
import { runPeFormStateTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A useActionState result rendered for a form submitted before hydration
 * survives hydration. Body: tests/shared-e2e/src/pe-form-state-scenario.ts.
 */
function describePeFormState(mode: "dev" | "build") {
  test.describe(`pe form state (${mode === "build" ? "production" : "dev"})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runPeFormStateTests({ url: (pathname) => f.url(pathname) });
  });
}

describePeFormState("dev");
describePeFormState("build");
