import { test } from "@playwright/test";
import { useFixture } from "./fixture";
import { defineFlaggedLoaderDefaultBoundaryTests } from "@shared/e2e";

// dc-t92: an ssr: false loader that throws on a document load with no
// errorBoundary() ends on the router's default error boundary. Fixture:
// test-app/src/urls/holey-throws.tsx. Own isolatedServer, like the other
// shell suites.

test.describe("flagged loader default error boundary", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  defineFlaggedLoaderDefaultBoundaryTests(() => ({ url: (p) => f.url(p) }));
});

test.describe("flagged loader default error boundary (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  defineFlaggedLoaderDefaultBoundaryTests(() => ({ url: (p) => f.url(p) }));
});
