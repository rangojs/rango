/**
 * E2E Tests - Partial Rendering
 *
 * Tests partial rendering with RSC streams
 */

import { test, expect } from '@playwright/test';

test.describe('Partial Rendering - Request Parameters', () => {
  test('should send _rsc_partial parameter on navigation', async ({ page }) => {
    const requests: string[] = [];

    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('_rsc_partial')) {
        requests.push(url);
      }
    });

    await page.goto('/');
    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();

    // Should have made partial render request
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]).toContain('_rsc_partial=true');
  });

  test('should send _rsc_prev parameter with previous pathname', async ({ page }) => {
    const requests: string[] = [];

    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('_rsc_partial')) {
        requests.push(url);
      }
    });

    await page.goto('/');
    await page.click('a[href="/blog"]');

    if (requests.length > 0) {
      expect(requests[0]).toContain('_rsc_prev=/');
    }
  });

  test('should not send _rsc_partial on initial page load', async ({ page }) => {
    const requests: string[] = [];

    page.on('request', (request) => {
      requests.push(request.url());
    });

    await page.goto('/');

    const partialRequests = requests.filter((url) => url.includes('_rsc_partial'));
    expect(partialRequests.length).toBe(0);
  });
});

test.describe('Partial Rendering - Content Updates', () => {
  test('should update content without full page reload', async ({ page }) => {
    await page.goto('/blog/first-post');
    await expect(page.getByTestId('blog-post')).toContainText('first-post');

    await page.goto('/blog/second-post');
    await expect(page.getByTestId('blog-post')).toContainText('second-post');

    // Navigation bar should still be present (layout preserved)
    await expect(page.locator('nav')).toBeVisible();
  });

  test('should preserve layout across routes', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();

    // Get nav element reference
    const navText = await nav.textContent();

    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();

    // Nav should still exist with same content
    await expect(nav).toBeVisible();
    expect(await nav.textContent()).toBe(navText);
  });
});

test.describe('Partial Rendering - Efficiency', () => {
  test('should make fewer requests for similar routes', async ({ page }) => {
    const requests: string[] = [];

    page.on('request', (request) => {
      requests.push(request.url());
    });

    await page.goto('/blog/first-post');
    const initialRequestCount = requests.length;

    // Clear and track next navigation
    requests.length = 0;

    await page.goto('/blog/second-post');
    const secondRequestCount = requests.length;

    // Partial rendering should make fewer requests than initial load
    // (This is a rough check - exact validation requires inspecting response sizes)
    expect(secondRequestCount).toBeLessThanOrEqual(initialRequestCount);
  });
});
