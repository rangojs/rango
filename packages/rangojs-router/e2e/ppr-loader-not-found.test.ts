import { test } from "@playwright/test";
import { runPprLoaderNotFoundTests } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";

// Issue #1213: a ppr route whose ssr: false loader answers notFound() after
// its shell was captured. The stale HIT's recapture retires the stored
// entries, so the next document is a live 404 and a navigation does not
// replay the deleted record. Fixture: test-app/src/urls/shell-cache-gone.tsx.
// Body: tests/shared-e2e/src/ppr-loader-not-found-scenario.ts, shared with
// tests/cloudflare-basic/e2e/ppr-loader-not-found.test.ts. Userland unit:
// src/testing/__tests__/serve-shell-request-loader-not-found.rsc-test.tsx.

function options(f: Fixture) {
  return {
    url: (pathname: string) => f.url(pathname),
    path: "/shell-cache/gone",
    deletePath: "/shell-cache/gone-delete",
    testIdPrefix: "shell-gone",
  };
}

test.describe("ppr ssr: false loader notFound() retires the shell (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runPprLoaderNotFoundTests(options(f));
});

test.describe("ppr ssr: false loader notFound() retires the shell (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runPprLoaderNotFoundTests(options(f));
});
