import { test } from "@playwright/test";
import { runPprSsrFalseInlineTests } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";

// Issue #1206: a shell HIT of a ppr route with an ssr: false loader ships a
// completed boundary in place, as the live render does, on workerd with
// CFCacheStore. Fixture: src/loaders/ppr-inline.ts and the /ppr-inline route
// in src/urls.tsx. The body is shared with
// packages/rangojs-router/e2e/ppr-ssr-false-inline.test.ts.

function options(f: Fixture) {
  return {
    url: (pathname: string) => f.url(pathname),
    path: "/ppr-inline",
    testIdPrefix: "ppr-inline",
  };
}

test.describe("ppr ssr: false inline boundary (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runPprSsrFalseInlineTests(options(f));
});

test.describe("ppr ssr: false inline boundary (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runPprSsrFalseInlineTests(options(f));
});
