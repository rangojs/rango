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
const OWN_BOUNDARIES =
  "a route whose loaders are all read behind their own boundaries shows its page, not its loading() fallback";
const GATED_ACTION =
  "an action commit transition({ when }) gated off shows no fallback when its data is in hand";
// Measured in both apps and both modes: 3 commits of the destination and 2
// of its reader for the inline boundary, 2 for loading(), 4 and 4 for the
// same route; the reader is handed 2 promises in each.
const ONE_COMMIT =
  "#1079: a clientUrls() navigation presents its destination at the click, and the server's answer and the clearing of the intent commit it again; its reader is handed a gate that never settles, then the real promise";
const OPEN_PRODUCTION: Record<string, string> = {
  [GATED_ACTION]:
    "#1079: the urgent commit suspends on a settled promise React has not read and shows the route's fallback for 300 ms",
  "a clientUrls() navigation to a route with an inline boundary is one commit":
    ONE_COMMIT,
  "a clientUrls() navigation to a route with loading() is one commit":
    ONE_COMMIT,
  "a clientUrls() same-route navigation is one commit": ONE_COMMIT,
  // A build only: a dev build shows that fallback while a client reference
  // loads, and the audit stays silent while the payload streams.
  [OWN_BOUNDARIES]:
    "#1079, #1080: on a cold click the route's loading() shows for about 300 ms although each loader is read behind a boundary of its own and the route's own content is in hand",
};
const { [OWN_BOUNDARIES]: _buildOnly, ...OPEN_IN_BOTH } = OPEN_PRODUCTION;
const OPEN_DEV: Record<string, string> = {
  ...OPEN_IN_BOTH,
  "same-route navigation inside a transition scope reconciles the route":
    "#1079: the route's boundary is handed a settled promise React has not read (audit I2); the transition holds, so nothing flashes",
  "an action that re-runs one of two loaders keeps the other reader on screen":
    "#1079: the action lane hands content on screen a settled promise React has not read (audit I2)",
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
