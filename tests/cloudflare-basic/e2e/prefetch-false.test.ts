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
  production: boolean,
) {
  definePrefetchFalseTests(test, {
    fixture: () => ({ url: (path) => f.url(path) }),
    expectNoPageError,
    production,
  });
}

test.describe("prefetch-false (dev)", () => {
  // Every case is independent (its own run id), and with the server 300 ms
  // away the file outgrows one shard: parallel mode lets --shard split it.
  test.describe.configure({ mode: "parallel" });
  const f = useFixture({ root: ".", mode: "dev" });
  prefetchFalseSuite(f, false);
});

test.describe("prefetch-false (production)", () => {
  // Every case is independent (its own run id), and with the server 300 ms
  // away the file outgrows one shard: parallel mode lets --shard split it.
  test.describe.configure({ mode: "parallel" });
  const f = useFixture({ root: ".", mode: "build" });
  prefetchFalseSuite(f, true);
});
