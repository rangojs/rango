import { test as base } from '@playwright/test';

/**
 * Custom fixture with server logging and fast-fail on errors
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    // Log all HTTP requests
    page.on('request', (request) => {
      const method = request.method();
      const url = new URL(request.url());
      // Only log requests to our app (not external resources)
      if (url.hostname === 'localhost') {
        console.log(`→ ${method} ${url.pathname}${url.search}`);
      }
    });

    // Log all HTTP responses with status codes
    page.on('response', (response) => {
      const status = response.status();
      const url = new URL(response.url());

      // Only log requests to our app
      if (url.hostname === 'localhost') {
        const emoji = status >= 500 ? '❌' : status >= 400 ? '⚠️' : '✓';
        console.log(`${emoji} ${status} ${url.pathname}${url.search}`);
      }

      // Fail immediately on 5xx errors
      if (status >= 500 && status < 600) {
        throw new Error(
          `Server error ${status}: ${url.pathname}\n` +
          `Test failed because the server returned an error.`
        );
      }
    });

    // Log browser console messages (server-side logs won't appear here)
    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();

      // Filter out noise
      if (text.includes('[vite]') || text.includes('HMR')) return;

      const prefix = type === 'error' ? '🔴' : type === 'warning' ? '🟡' : '💬';
      console.log(`${prefix} Browser: ${text}`);
    });

    await use(page);
  },
});

export { expect } from '@playwright/test';
