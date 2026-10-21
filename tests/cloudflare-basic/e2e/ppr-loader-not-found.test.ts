import { test } from "@playwright/test";
import { runPprLoaderNotFoundTests } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";

// Issue #1213 on workerd with CFCacheStore: a ppr route whose ssr: false
// loader answers notFound() after its shell was captured. The stale HIT's
// recapture retires the stored entries, so the next document is a live 404
// and a navigation does not replay the deleted record. Fixture:
// src/loaders/ppr-gone.ts and the /ppr-gone/:id route in src/urls.tsx. The
// body is shared with packages/rangojs-router/e2e/ppr-loader-not-found.test.ts.

function options(f: Fixture) {
  return {
    url: (pathname: string) => f.url(pathname),
    path: "/ppr-gone",
    deletePath: "/ppr-gone-delete",
    testIdPrefix: "ppr-gone",
  };
}

test.describe("ppr ssr: false loader notFound() retires the shell (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runPprLoaderNotFoundTests(options(f));
});

test.describe("ppr ssr: false loader notFound() retires the shell (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runPprLoaderNotFoundTests(options(f));
});
