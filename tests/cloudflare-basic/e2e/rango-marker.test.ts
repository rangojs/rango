import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

const ROUTER_VERSION: string = JSON.parse(
  readFileSync(
    new URL("../../../packages/rangojs-router/package.json", import.meta.url),
    "utf8",
  ),
).version;

function defineMarkerTests(f: ReturnType<typeof useFixture>) {
  test("window.__rango is a frozen { version } after hydration", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    expect(await page.evaluate(() => (window as any).__rango)).toEqual({
      version: ROUTER_VERSION,
    });
    expect(
      await page.evaluate(() => Object.isFrozen((window as any).__rango)),
    ).toBe(true);
  });
}

test.describe("rango marker", () => {
  defineMarkerTests(useFixture({ root: ".", mode: "dev" }));
});

test.describe("rango marker (production)", () => {
  defineMarkerTests(useFixture({ root: ".", mode: "build" }));
});
