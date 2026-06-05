// Public entry for the consumer e2e harness. `createRangoE2E({ test, expect })`
// wires the server fixture, page helpers, parity helpers, and matchers around
// the consumer's Playwright `test`/`expect` objects so this module never
// imports `@playwright/test` at runtime (type-only imports are erased).

import type { Expect, TestType } from "@playwright/test";
import {
  createUseFixture,
  type Fixture,
  type FixtureOptions,
} from "./fixture.js";
import {
  createPageHelpers,
  createStopwatch,
  getHistoryState,
  getNumericContent,
  goBack,
  goForward,
  isVisibleInViewport,
  measureTime,
  type PageHelpers,
  parseNumber,
  type Stopwatch,
  testId,
  waitForElement,
  waitForHydration,
  waitForNavigation,
} from "./page-helpers.js";
import {
  createParity,
  type ExpectParityOptions,
  type Parity,
  type ParityDescribeOptions,
  type ParityIntent,
} from "./parity.js";
import { createRangoMatchers, type RangoMatchers } from "./matchers.js";

// Cache-status helpers are pure (cache-status.ts imports only TYPES), so they
// are safe to surface from this Playwright-runnable entry. Importing them from
// the `@rangojs/router/testing` barrel does NOT work in a plain Playwright
// runner — the barrel transitively pulls the build-only `@rangojs/router:version`
// virtual via the route-manifest path. Asserting cache status on a real
// response is an e2e activity, so this is their Playwright-safe home.
export {
  assertCacheStatus,
  parseCacheHeader,
  createCacheSink,
  filterCacheDecisions,
  type CacheSink,
  type ExpectedCacheStatus,
  type CacheStatusTarget,
} from "../cache-status.js";

// Re-export standalone helpers and all public types so the barrel can re-export
// them from a single module.
export {
  testId,
  waitForHydration,
  waitForNavigation,
  goBack,
  goForward,
  getHistoryState,
  waitForElement,
  isVisibleInViewport,
  parseNumber,
  getNumericContent,
  createStopwatch,
  measureTime,
  createPageHelpers,
  createUseFixture,
  createParity,
  createRangoMatchers,
};
export type {
  Fixture,
  FixtureOptions,
  PageHelpers,
  Stopwatch,
  Parity,
  ParityIntent,
  ParityDescribeOptions,
  ExpectParityOptions,
  RangoMatchers,
};

export interface RangoE2E extends PageHelpers, Parity {
  useFixture: (options: FixtureOptions) => Fixture;
  testNoJs: TestType<any, any>;
  rangoMatchers: RangoMatchers;
  // Standalone helpers, re-surfaced for convenience.
  testId: typeof testId;
  waitForHydration: typeof waitForHydration;
  waitForNavigation: typeof waitForNavigation;
  goBack: typeof goBack;
  goForward: typeof goForward;
  getHistoryState: typeof getHistoryState;
  waitForElement: typeof waitForElement;
  isVisibleInViewport: typeof isVisibleInViewport;
  parseNumber: typeof parseNumber;
  getNumericContent: typeof getNumericContent;
  createStopwatch: typeof createStopwatch;
  measureTime: typeof measureTime;
}

/**
 * Wire the full e2e harness around a consumer's Playwright `test`/`expect`.
 *
 * @param defaultRoot - fallback app root for `parityDescribe` when a call omits
 *   `options.root`.
 */
export function createRangoE2E({
  test,
  expect,
  defaultRoot,
}: {
  test: TestType<any, any>;
  expect: Expect;
  defaultRoot?: string;
}): RangoE2E {
  const useFixture = createUseFixture(test);
  const pageHelpers = createPageHelpers(expect);
  const parity = createParity({ test, expect, useFixture, defaultRoot });
  const rangoMatchers = createRangoMatchers(expect);
  const testNoJs = test.extend({
    javaScriptEnabled: ({}, use: (value: boolean) => Promise<void>) =>
      use(false),
  });

  return {
    useFixture,
    testNoJs,
    rangoMatchers,
    ...parity,
    ...pageHelpers,
    // Standalone helpers.
    testId,
    waitForHydration,
    waitForNavigation,
    goBack,
    goForward,
    getHistoryState,
    waitForElement,
    isVisibleInViewport,
    parseNumber,
    getNumericContent,
    createStopwatch,
    measureTime,
  };
}
