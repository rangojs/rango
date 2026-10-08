import { test } from "@playwright/test";
import { definePrefetchFalseTests } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError } from "./helper";

// `prefetch: false` on loader() and loading(): a prefetch skips the flagged
// work, the click that adopts it shows the fallback and sends one fill request
// (docs/design/prefetch-false.md). Every case reads the fixture's server-side
// run counters. Fixture: test-app/src/urls/prefetch-false.tsx; tests and
// bodies: tests/shared-e2e/src/prefetch-false.ts.
function prefetchFalseSuite(f: Fixture) {
  definePrefetchFalseTests(test, {
    fixture: () => ({ url: (path) => f.url(path) }),
    expectNoPageError,
  });
}

test.describe("prefetch-false", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  prefetchFalseSuite(f);
});

test.describe("prefetch-false (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  prefetchFalseSuite(f);
});
