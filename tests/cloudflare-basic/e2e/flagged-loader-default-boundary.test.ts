import { test } from "@playwright/test";
import { useFixture } from "./fixture";
import { defineFlaggedLoaderDefaultBoundaryTests } from "@shared/e2e";

// dc-t92 on workerd with CFCacheStore: an ssr: false loader that throws on a
// document load with no errorBoundary() ends on the router's default error
// boundary. Fixture: src/pages/holey-throws.tsx.

test.describe("flagged loader default error boundary", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineFlaggedLoaderDefaultBoundaryTests(() => ({ url: (p) => f.url(p) }));
});

test.describe("flagged loader default error boundary (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineFlaggedLoaderDefaultBoundaryTests(() => ({ url: (p) => f.url(p) }));
});
