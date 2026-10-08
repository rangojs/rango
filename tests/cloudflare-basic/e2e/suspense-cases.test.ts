import { describeSuspenseCases } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

// Body and open cases: tests/shared-e2e/src/suspense-cases.ts.
describeSuspenseCases("dev", waitForHydration, () =>
  useFixture({ root: ".", mode: "dev" }),
);
describeSuspenseCases("build", waitForHydration, () =>
  useFixture({ root: ".", mode: "build" }),
);
