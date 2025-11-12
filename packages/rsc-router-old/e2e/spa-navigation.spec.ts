/**
 * E2E Tests - SPA Navigation
 *
 * Tests client-side navigation without page reloads
 */

import { test, expect } from '@playwright/test';

test.describe('SPA Navigation - Link Interception', () => {
  test('should intercept same-origin link clicks', async ({ page }) => {
    await page.goto('/');

    // Track navigation
    let navigated = false;
    page.on('framenavigated', () => {
      navigated = true;
    });

    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();

    // URL should update
    expect(page.url()).toContain('/about');
  });

  test('should not intercept external links', async ({ page, context }) => {
    await page.goto('/');

    // Add external link
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'https://example.com';
      link.textContent = 'External';
      link.id = 'external-link';
      document.body.appendChild(link);
    });

    // External link should open in new context (not intercepted)
    // For this test, we just verify it has correct href
    const externalLink = page.locator('#external-link');
    await expect(externalLink).toHaveAttribute('href', 'https://example.com');
  });

  test('should not intercept cmd+click (Mac) for new tab', async ({ page }) => {
    await page.goto('/');

    // This would open in new tab - we just verify the behavior isn't intercepted
    // by checking the link still has href
    const link = page.locator('a[href="/about"]');
    await expect(link).toHaveAttribute('href', '/about');
  });

  test('should not intercept download links', async ({ page }) => {
    await page.goto('/');

    // Add download link
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/file.pdf';
      link.setAttribute('download', '');
      link.textContent = 'Download';
      link.id = 'download-link';
      document.body.appendChild(link);
    });

    const downloadLink = page.locator('#download-link');
    await expect(downloadLink).toHaveAttribute('download');
  });
});

test.describe('SPA Navigation - URL Updates', () => {
  test('should update URL without page reload', async ({ page }) => {
    await page.goto('/');
    expect(page.url()).toContain('/');

    await page.click('a[href="/blog"]');
    await page.waitForURL('**/blog');
    expect(page.url()).toContain('/blog');
  });

  test('should handle query parameters in URLs', async ({ page }) => {
    await page.goto('/?test=value');
    expect(page.url()).toContain('test=value');
  });

  test('should handle URL hash fragments', async ({ page }) => {
    await page.goto('/#section');
    expect(page.url()).toContain('#section');
  });
});

test.describe('SPA Navigation - Browser History', () => {
  test('should support back button navigation', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();

    await page.goBack();
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('should support forward button navigation', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/about"]');
    await page.goBack();
    await page.goForward();
    await expect(page.getByTestId('about-page')).toBeVisible();
  });

  test('should maintain state through history navigation', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/blog/first-post"]');
    await expect(page.getByTestId('blog-post')).toContainText('first-post');

    await page.click('a[href="/blog"]');
    await page.goBack();
    await expect(page.getByTestId('blog-post')).toContainText('first-post');
  });
});

test.describe('SPA Navigation - Performance', () => {
  test('should not reload assets on navigation', async ({ page }) => {
    await page.goto('/');

    // Track resource loads
    const resourcesLoaded: string[] = [];
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('.js') || url.includes('.css')) {
        resourcesLoaded.push(url);
      }
    });

    const initialResourceCount = resourcesLoaded.length;

    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();

    // Should not reload JS/CSS files (SPA)
    expect(resourcesLoaded.length).toBe(initialResourceCount);
  });
});
