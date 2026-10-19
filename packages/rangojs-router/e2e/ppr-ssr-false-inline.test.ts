import { test } from "@playwright/test";
import { runPprSsrFalseInlineTests } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";

// Issue #1206: a shell HIT of a ppr route with an ssr: false loader ships a
// completed boundary in place, as the live render does. Fixture:
// test-app/src/urls/shell-cache-inline.tsx. Body:
// tests/shared-e2e/src/ppr-ssr-false-inline-scenario.ts, shared with
// tests/cloudflare-basic/e2e/ppr-ssr-false-inline.test.ts. The capture's Fizz
// output is pinned in src/ssr/__tests__/shell-handlers.test.tsx.

function options(f: Fixture) {
  return {
    url: (pathname: string) => f.url(pathname),
    path: "/shell-cache/inline",
    testIdPrefix: "shell-inline",
  };
}

test.describe("ppr ssr: false inline boundary (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runPprSsrFalseInlineTests(options(f));
});

test.describe("ppr ssr: false inline boundary (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runPprSsrFalseInlineTests(options(f));
});
