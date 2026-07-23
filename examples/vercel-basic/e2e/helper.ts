import test, { type Page, type Locator, expect } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * The e2e runs the app with RANGO_TRACE_DEBUG=1 so the in-memory recording
 * tracer (src/trace-debug.ts) is wired via createVercelTracing({ tracer }) and
 * the captured rango.* span tree is readable through the /__debug/trace route.
 * The real path (@vercel/otel registerOTel) is covered by scripts/smoke.mjs.
 */
const DEBUG_ENV = {
  ...process.env,
  RANGO_TRACE_DEBUG: "1",
  RANGO_VERCEL_CACHE_E2E: "1",
};

/**
 * Dev-mode spec. Title intentionally has NO "(production)" tag so it lands in
 * the dev bucket.
 */
export function devSpec(name: string, body: (f: Fixture) => void): void {
  test.describe.serial(name, () => {
    const f = useFixture({
      root: ".",
      mode: "dev",
      cliOptions: { env: DEBUG_ENV },
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
      cliOptions: { env: DEBUG_ENV },
    });
    body(f);
  });
}

/** Wait for React hydration to complete (rango sets data-hydrated on <html>). */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    { timeout: 20000 },
  );
}

export async function expectNoReload(page: Page) {
  await page.evaluate(() => {
    const marker = document.createElement("meta");
    marker.setAttribute("name", "x-reload-check");
    document.head.append(marker);
  });

  return {
    [Symbol.asyncDispose]: async () => {
      await expect(page.locator('meta[name="x-reload-check"]')).toBeAttached({
        timeout: 100,
      });
      await page.evaluate(() => {
        document.querySelector('meta[name="x-reload-check"]')!.remove();
      });
    },
  };
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
