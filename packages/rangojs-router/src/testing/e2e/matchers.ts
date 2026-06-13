// Custom Playwright matchers for Rango assertions. Returned as an object
// suitable for `expect.extend(...)`. v1 ships only `toHaveRangoPathname`.

import type { Expect, Page } from "@playwright/test";

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

export interface RangoMatchers {
  toHaveRangoPathname: (page: Page, expected: string) => MatcherResult;
}

/**
 * Build the matcher object for `expect.extend(createRangoMatchers(expect))`.
 *
 * `toHaveRangoPathname(page, expected)` asserts that the pathname of the page's
 * current URL equals `expected`.
 *
 * TODO: `toHaveSegments` / `toHaveParams` are intentionally not implemented.
 * They require a client-emitted signal (the active segment chain / resolved
 * params exposed on the page) that does not exist yet; implementing them by
 * scraping the DOM would be a guess. Add them once the router emits that signal.
 */
export function createRangoMatchers(_expect: Expect): RangoMatchers {
  return {
    toHaveRangoPathname(page: Page, expected: string): MatcherResult {
      const actual = new URL(page.url()).pathname;
      const pass = actual === expected;
      return {
        pass,
        message: () =>
          pass
            ? `Expected pathname not to be "${expected}"`
            : `Expected pathname "${expected}" but got "${actual}"`,
      };
    },
  };
}

// Type augmentation so consumers can call `await expect(page).toHaveRangoPathname("/x")`
// after `expect.extend(rangoMatchers)`, without re-declaring the matcher.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace PlaywrightTest {
    interface Matchers<R, T> {
      toHaveRangoPathname(expected: string): R;
    }
  }
}
