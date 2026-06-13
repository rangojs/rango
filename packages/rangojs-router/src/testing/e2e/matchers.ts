import type { Expect, Page } from "@playwright/test";

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

export interface RangoMatchers {
  toHaveRangoPathname: (page: Page, expected: string) => MatcherResult;
}

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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace PlaywrightTest {
    interface Matchers<R, T> {
      toHaveRangoPathname(expected: string): R;
    }
  }
}
