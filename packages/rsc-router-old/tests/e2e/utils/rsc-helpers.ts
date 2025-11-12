import { Page, Request, Response } from '@playwright/test';

/**
 * Helper utilities for testing RSC Router navigation and segment handling
 */

export interface NavigationRequest {
  url: string;
  hasParameter: string | null;
  isDocumentRequest: boolean;
  isPartialRequest: boolean;
  headers: Record<string, string>;
  response?: Response;
}

/**
 * Waits for a navigation request and captures details
 */
export async function waitForNavigation(
  page: Page,
  targetPath: string
): Promise<NavigationRequest> {
  const requestPromise = page.waitForRequest(
    (req) => {
      const url = new URL(req.url());
      return url.pathname === targetPath;
    },
    { timeout: 5000 }
  );

  const request = await requestPromise;
  const url = new URL(request.url());
  const hasParameter = url.searchParams.get('_has');
  const accept = request.headers()['accept'] || '';

  return {
    url: request.url(),
    hasParameter,
    isDocumentRequest: accept.includes('text/html'),
    isPartialRequest: hasParameter !== null,
    headers: request.headers(),
    response: await request.response(),
  };
}

/**
 * Monitors all navigation requests during a callback
 */
export async function captureNavigationRequests(
  page: Page,
  callback: () => Promise<void>
): Promise<NavigationRequest[]> {
  const requests: NavigationRequest[] = [];

  const listener = (req: Request) => {
    const url = new URL(req.url());

    // Only capture requests to our app on localhost (not static assets)
    if (
      url.hostname === 'localhost' &&
      !url.pathname.startsWith('/src/') &&
      !url.pathname.startsWith('/@') &&
      !url.pathname.startsWith('/node_modules') &&
      !url.pathname.endsWith('.css') &&
      !url.pathname.endsWith('.js') &&
      !url.pathname.endsWith('.map') &&
      !url.pathname.endsWith('.tsx') &&
      !url.pathname.endsWith('.ts')
    ) {
      const hasParameter = url.searchParams.get('_has');
      const requestHeaders = req.headers();
      // Headers in Playwright can be case-insensitive, normalize to lowercase
      const accept = requestHeaders['accept'] || requestHeaders['Accept'] || '';
      const resourceType = req.resourceType();

      requests.push({
        url: req.url(),
        hasParameter,
        // Document requests have resourceType 'document' or Accept header with text/html
        isDocumentRequest: resourceType === 'document' || accept.includes('text/html'),
        isPartialRequest: hasParameter !== null,
        // Normalize headers to lowercase keys for consistent access
        headers: Object.keys(requestHeaders).reduce((acc, key) => {
          acc[key.toLowerCase()] = requestHeaders[key];
          return acc;
        }, {} as Record<string, string>),
      });
    }
  };

  // Set up listener BEFORE calling callback
  page.on('request', listener);

  try {
    // Execute the callback and wait for it
    await callback();

    // Give a small delay to ensure all requests are captured
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  } finally {
    page.off('request', listener);
  }

  return requests;
}

/**
 * Extracts segment IDs from _has parameter
 */
export function parseHasParameter(hasParam: string | null): string[] {
  if (!hasParam) return [];
  return hasParam.split(',').filter(Boolean);
}

/**
 * Checks if a DOM element still exists (wasn't re-rendered)
 */
export async function elementWasPreserved(
  page: Page,
  selector: string,
  markerId: string
): Promise<boolean> {
  const marker = await page.getAttribute(selector, `data-test-${markerId}`);
  return marker === 'preserved';
}

/**
 * Adds a marker to an element to track if it's re-rendered
 */
export async function markElement(
  page: Page,
  selector: string,
  markerId: string
): Promise<void> {
  await page.evaluate(
    ({ sel, id }) => {
      const element = document.querySelector(sel);
      if (element) {
        element.setAttribute(`data-test-${id}`, 'preserved');
      }
    },
    { sel: selector, id: markerId }
  );
}

/**
 * Gets console logs that match a pattern
 */
export function captureConsoleLogs(page: Page): Promise<string[]> {
  const logs: string[] = [];

  page.on('console', (msg) => {
    logs.push(msg.text());
  });

  return Promise.resolve(logs);
}

/**
 * Waits for specific console log pattern
 */
export async function waitForConsoleLog(
  page: Page,
  pattern: string | RegExp,
  timeout = 5000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for console log matching: ${pattern}`));
    }, timeout);

    const listener = (msg: any) => {
      const text = msg.text();
      const matches =
        typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);

      if (matches) {
        clearTimeout(timer);
        page.off('console', listener);
        resolve(text);
      }
    };

    page.on('console', listener);
  });
}

/**
 * Verifies segment ID format (L0, R2, P3, etc.)
 */
export function isValidSegmentId(id: string): boolean {
  return /^[LRP]\d+$/.test(id);
}

/**
 * Counts how many times the page did a full reload
 */
export function countPageReloads(requests: NavigationRequest[]): number {
  return requests.filter((req) => req.isDocumentRequest).length;
}

/**
 * Gets all partial navigation requests with _has parameter
 */
export function getPartialRequests(
  requests: NavigationRequest[]
): NavigationRequest[] {
  return requests.filter((req) => req.isPartialRequest);
}
