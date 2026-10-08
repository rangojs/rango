import { describeSuspenseCases } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

// Body and open cases: tests/shared-e2e/src/suspense-cases.ts.
const fixture = (mode: "dev" | "build") =>
  useFixture({ root: "./e2e/test-app", mode });
describeSuspenseCases("dev", waitForHydration, fixture);
describeSuspenseCases("build", waitForHydration, fixture);
