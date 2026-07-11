import type { Expect, TestType } from "@playwright/test";
import {
  createUseFixture,
  type Fixture,
  type FixtureOptions,
} from "./fixture.js";
import {
  blockPrefetch,
  unblockPrefetch,
  createPageHelpers,
  createStopwatch,
  getHistoryState,
  getNumericContent,
  goBack,
  goForward,
  isPrefetchRequest,
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

export {
  assertCacheStatus,
  assertCacheDecision,
  parseCacheHeader,
  createCacheSink,
  filterCacheDecisions,
  type CacheSink,
  type ExpectedCacheStatus,
  type CacheStatusTarget,
} from "../cache-status.js";
export {
  assertPprReplayStatus,
  assertShellStatus,
  parsePprReplayStatus,
  parseShellStatus,
  PPR_REPLAY_STATUS_HEADER,
  shellCacheKey,
  SHELL_STATUS_HEADER,
  type PprReplayBypassReason,
  type PprReplayStatus,
  type ShellStatus,
  type ShellStatusTarget,
} from "../shell-status.js";
export {
  testId,
  waitForHydration,
  waitForNavigation,
  goBack,
  goForward,
  getHistoryState,
  waitForElement,
  isVisibleInViewport,
  isPrefetchRequest,
  blockPrefetch,
  unblockPrefetch,
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
