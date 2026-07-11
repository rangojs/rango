import test, { type Page, type Locator, expect } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * Dev-mode spec. Title intentionally has NO "(production)" tag so it lands in
 * the dev bucket.
 */
export function devSpec(name: string, body: (f: Fixture) => void): void {
  test.describe.serial(name, () => {
    const f = useFixture({
      root: ".",
      mode: "dev",
    });
    body(f);
  });
}

/**
 * Production-mode spec. The helper couples `mode: "build"` with the
 * "(production)" title so the suite can never drift into the wrong bucket
 * (see CLAUDE.md "Dev/prod bucketing convention"). Builds the app and serves
 * the assembled .vercel/output function via scripts/preview.mjs.
 */
export function prodSpec(name: string, body: (f: Fixture) => void): void {
  test.describe.serial(`${name} (production)`, () => {
    const f = useFixture({
      root: ".",
      mode: "build",
      buildCommand: "pnpm build",
      command: "pnpm preview:vercel",
    });
    body(f);
  });
}

/** Collect and verify no uncaught page errors occurred. */
export function expectNoPageError(page: Page) {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  return {
    [Symbol.dispose]: () => {
      expect(errors).toEqual([]);
    },
  };
}

/** Locator by data-testid. */
export function testId(page: Page, id: string): Locator {
  return page.locator(`[data-testid="${id}"]`);
}
