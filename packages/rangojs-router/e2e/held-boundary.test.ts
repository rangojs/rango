import { test } from "@playwright/test";
import {
  HELD_BOUNDARY_NEW_TITLE,
  heldBoundaryTitle,
  runHeldBoundaryTests,
} from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * A boundary on screen must not be replaced by its loading() fallback when
 * nothing in it is pending. Body: tests/shared-e2e/src/held-boundary-scenario.ts.
 */

// Red today (#1079), by test title. Remove an entry when its test passes.
const FLASH =
  "#1079: after a click whose tree was awaited, the plain click hands the boundary on screen a settled promise React has not read, and the urgent commit shows its fallback for 300 ms";
const AWAITED = [
  "a fully prefetched click",
  "a fully prefetched click, back and forward",
];
const open = (scenarios: string[]): Record<string, string> =>
  Object.fromEntries(
    scenarios.flatMap((scenario) =>
      AWAITED.map((entry) => [heldBoundaryTitle(scenario, entry), FLASH]),
    ),
  );

const OPEN_DEV: Record<string, string> = {
  ...open([
    "layout with loading() and no loaders",
    "layout with loading() and a loader",
    "parallel slot with a loader and loading()",
  ]),
  // The audit sees it at the entry: the slot's boundary is new to the page.
  [heldBoundaryTitle(
    "parallel slot with a loader and loading()",
    "a plain click",
  )]:
    "#1079: a slot boundary new to the page reads a settled aggregate promise React has not read, and its fallback mounts with nothing pending (audit I3)",
};
const OPEN_PRODUCTION: Record<string, string> = {
  ...open([
    "layout with loading() and no loaders",
    "layout with loading() and a loader",
    "parallel slot with a loader and loading()",
  ]),
  [HELD_BOUNDARY_NEW_TITLE]:
    "#1079: a boundary new to the page is handed a settled promise React has not read, and its fallback shows with nothing pending",
};

function describeHeldBoundary(mode: "dev" | "build") {
  const production = mode === "build";
  test.describe(`held boundary (${production ? "production" : "dev"})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);
    runHeldBoundaryTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
      production,
      open: production ? OPEN_PRODUCTION : OPEN_DEV,
    });
  });
}

describeHeldBoundary("dev");
describeHeldBoundary("build");
