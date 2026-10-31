import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * A push made after real workerd I/O (a KV read, a dynamic import, a fetch(),
 * a timer) lands under the segment that made it, so useHandle reads in
 * segment order: a loading() route beside its slot, a loading() slot before a
 * sibling slot and the route, and a loader a route's loader() body starts. The
 * segment travels in the handler's async context (server/context.ts
 * runAsSegment), so this also shows that context survives those awaits in
 * workerd. Fixture: src/pages/streamed-handle-owner.tsx.
 */
const SHO = "/streamed-handle-owner";

const CASES: ReadonlyArray<
  readonly [name: string, page: string, crumbs: string[]]
> = [
  [
    "a loading() route's push after I/O stays before its slot's",
    "route",
    ["Shell", "Route", "Side"],
  ],
  [
    "a loading() slot's push after I/O stays before its sibling slot's",
    "slot",
    ["Shell", "A", "B", "Page"],
  ],
  [
    "a loader a loader body starts after I/O files under the route",
    "loader",
    ["Shell", "Page", "Inner", "Side"],
  ],
];

async function expectTrail(page: Page, crumbs: string[]): Promise<void> {
  await expect(page.getByTestId("sho-crumb")).toHaveText(crumbs, {
    timeout: 10000,
  });
}

function describeStreamedHandleOwner(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`streamed handle owner (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    for (const [name, pageName, crumbs] of CASES) {
      test(`${name}: document`, async ({ page }) => {
        await page.goto(f.url(`${SHO}/${pageName}`));
        await expectTrail(page, crumbs);
      });

      test(`${name}: navigation`, async ({ page }) => {
        await page.goto(f.url(SHO));
        await waitForHydration(page);
        await expectTrail(page, ["Shell"]);
        await page.getByTestId(`sho-link-${pageName}`).click();
        await expect(page).toHaveURL(new RegExp(`${SHO}/${pageName}$`));
        await expectTrail(page, crumbs);
      });
    }
  });
}

describeStreamedHandleOwner("dev");
describeStreamedHandleOwner("build");
