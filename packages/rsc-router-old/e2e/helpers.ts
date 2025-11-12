/**
 * E2E Test Helpers
 *
 * Utilities for Playwright E2E tests
 */

import type { Page } from '@playwright/test';

/**
 * Wait for RSC navigation to complete
 */
export async function waitForNavigation(page: Page): Promise<void> {
  // Wait for network idle after navigation
  await page.waitForLoadState('networkidle');
}

/**
 * Get current segment IDs from browser console
 */
export async function getSegmentIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    // Access the global segment store if available
    return (window as any).__SEGMENT_IDS__ || [];
  });
}

/**
 * Check if navigation was SPA (no full page reload)
 */
export async function wasSPANavigation(page: Page): Promise<boolean> {
  const navigationType = await page.evaluate(() => {
    const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    return entries[0]?.type;
  });
  return navigationType !== 'reload';
}

/**
 * Get network requests matching pattern
 */
export async function getRequests(
  page: Page,
  pattern: string | RegExp
): Promise<string[]> {
  const requests: string[] = [];

  page.on('request', (request) => {
    const url = request.url();
    if (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)) {
      requests.push(url);
    }
  });

  return requests;
}
