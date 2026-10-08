import { test } from "@playwright/test";
import { definePrefetchFalseTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError } from "./helper";

// `prefetch: false` on loader() and loading() on workerd: the same tests as
// packages/rangojs-router/e2e/prefetch-false.test.ts (tests and bodies:
// tests/shared-e2e/src/prefetch-false.ts; docs/design/prefetch-false.md).
// Fixture: src/pages/prefetch-false.tsx. The run counters are module state of
// the worker, read back through /prefetch-false/__counts.
function prefetchFalseSuite(
  f: ReturnType<typeof useFixture>,
  production = false,
) {
  definePrefetchFalseTests(test, {
    fixture: () => ({ url: (path) => f.url(path), production }),
    expectNoPageError,
  });
}

test.describe("prefetch-false (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  prefetchFalseSuite(f);
});

test.describe("prefetch-false (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  prefetchFalseSuite(f, true);
});
