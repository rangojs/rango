/**
 * E2E Tests - RSC Streaming
 *
 * Tests RSC stream format and integration
 */

import { test, expect } from '@playwright/test';

test.describe('RSC Streaming - Response Format', () => {
  test('should receive RSC stream on navigation', async ({ page }) => {
    const rscRequests: any[] = [];

    page.on('response', (response) => {
      const contentType = response.headers()['content-type'];
      if (contentType?.includes('x-component')) {
        rscRequests.push({
          url: response.url(),
          status: response.status(),
          contentType,
        });
      }
    });

    await page.goto('/');
    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();

    // Should have received RSC stream response
    expect(rscRequests.length).toBeGreaterThan(0);
  });

  test('should return 200 status for valid routes', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('should return 404 for invalid routes', async ({ page }) => {
    const response = await page.goto('/nonexistent');
    expect(response?.status()).toBe(404);
  });
});

test.describe('RSC Streaming - Hydration', () => {
  test('should hydrate page from SSR', async ({ page }) => {
    await page.goto('/');

    // Page should be visible immediately (SSR)
    await expect(page.getByTestId('home-page')).toBeVisible();

    // Wait for hydration
    await page.waitForLoadState('networkidle');

    // Page should still be visible (hydrated)
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('should have interactive elements after hydration', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Links should be clickable (hydrated)
    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();
  });
});

test.describe('RSC Streaming - Content Type', () => {
  test('should serve HTML for browser requests', async ({ page }) => {
    const response = await page.goto('/');
    const contentType = response?.headers()['content-type'];
    expect(contentType).toContain('text/html');
  });

  test('should include RSC payload in HTML', async ({ page }) => {
    await page.goto('/');

    // Check for FLIGHT_DATA script (rsc-html-stream injection)
    const hasFlightData = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      return scripts.some(script =>
        script.textContent?.includes('FLIGHT') ||
        script.textContent?.includes('rsc')
      );
    });

    // RSC payload should be injected
    expect(hasFlightData).toBe(true);
  });
});
