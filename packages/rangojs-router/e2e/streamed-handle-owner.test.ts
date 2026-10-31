import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * A push made after a short await (eight microtasks, or a setTimeout(0))
 * lands under the segment that made it, so useHandle reads in segment order: a
 * loading() route beside its slot, a loading() slot before a sibling slot and
 * the route, and a loader a route's loader() body starts. The walker does not
 * await a streamed handler, so its push reads the segment from its async
 * context (server/context.ts runAsSegment), not the walker's moving pin.
 * Fixture: test-app/src/urls/streamed-handle-owner.tsx.
 */
const SHO = "/streamed-handle-owner";

const WAITS: ReadonlyArray<readonly [wait: string, label: string]> = [
  ["microtasks", "eight microtasks"],
  ["timer", "a timer"],
];

const CASES: ReadonlyArray<
  readonly [name: string, page: string, crumbs: string[]]
> = [
  [
    "a loading() route's push stays before its slot's",
    "route",
    ["Shell", "Route", "Side"],
  ],
  [
    "a loading() slot's push stays before its sibling slot's",
    "slot",
    ["Shell", "A", "B", "Page"],
  ],
  [
    "a loader a loader body starts files under the route",
    "loader",
    ["Shell", "Page", "Inner", "Side"],
  ],
];

async function expectTrail(page: Page, crumbs: string[]): Promise<void> {
  await expect(page.getByTestId("sho-crumb")).toHaveText(crumbs);
}

function describeStreamedHandleOwner(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`streamed handle owner (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    for (const [wait, waitLabel] of WAITS) {
      for (const [name, pageName, crumbs] of CASES) {
        const path = `${SHO}/${wait}/${pageName}`;

        test(`${name} after ${waitLabel}: document`, async ({ page }) => {
          await page.goto(f.url(path));
          await expectTrail(page, crumbs);
        });

        test(`${name} after ${waitLabel}: navigation`, async ({ page }) => {
          await page.goto(f.url(SHO));
          await waitForHydration(page);
          await expectTrail(page, ["Shell"]);
          await page.getByTestId(`sho-link-${wait}-${pageName}`).click();
          await expect(page).toHaveURL(new RegExp(`${path}$`));
          await expectTrail(page, crumbs);
        });
      }
    }
  });
}

describeStreamedHandleOwner("dev");
describeStreamedHandleOwner("build");
