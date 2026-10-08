import { test } from "@playwright/test";
import { runSuspenseCases } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * The suspense contract, flow by flow. Body:
 * tests/shared-e2e/src/suspense-cases.ts. Contract:
 * docs/internal/suspense-contract.md.
 */

// Red today, by case title. Remove an entry when its case passes.
// Measured in both apps and both modes: 3 commits of the destination and 2
// of its reader for the inline boundary, 2 for loading(), 4 and 4 for the
// same route; the reader is handed 2 promises in each.
const ONE_COMMIT =
  "#1079: a clientUrls() navigation presents its destination at the click, and the server's answer and the clearing of the intent commit it again; its reader is handed a gate that never settles, then the real promise";
const OPEN_DEV: Record<string, string> = {
  "a clientUrls() navigation to a route with an inline boundary is one commit":
    ONE_COMMIT,
  "a clientUrls() navigation to a route with loading() is one commit":
    ONE_COMMIT,
  "a clientUrls() same-route navigation is one commit": ONE_COMMIT,
};
// A build only: a dev build shows that fallback while a client reference
// loads, and the audit stays silent while the payload streams.
const OPEN_PRODUCTION: Record<string, string> = {
  ...OPEN_DEV,
  "a client component directly in a route's content does not show the route's loading() on a cold click":
    "#1079: the click is the first use of the client component's module in the document; its chunk is already fetched, but the Flight client waits for the module's import() (3 to 6 ms) and the route's loading() is the nearest boundary: 300 ms",
};

function describeSuspenseCases(mode: "dev" | "build") {
  const production = mode === "build";
  test.describe(`suspense cases (${production ? "production" : "dev"})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);
    runSuspenseCases({
      url: (pathname) => f.url(pathname),
      waitForHydration,
      production,
      open: production ? OPEN_PRODUCTION : OPEN_DEV,
    });
  });
}

describeSuspenseCases("dev");
describeSuspenseCases("build");
