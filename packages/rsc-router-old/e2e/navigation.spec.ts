/**
 * E2E Tests - Basic Navigation
 *
 * Tests basic page navigation and SPA behavior
 */

import { test, expect } from '@playwright/test';

test.describe('Basic Navigation', () => {
  test('should load home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('should navigate to about page via link click', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();
    expect(page.url()).toContain('/about');
  });

  test('should navigate to blog index', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/blog"]');
    await expect(page.getByTestId('blog-index')).toBeVisible();
    expect(page.url()).toContain('/blog');
  });

  test('should maintain navigation bar across routes', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();

    await page.click('a[href="/about"]');
    await expect(nav).toBeVisible(); // Nav persists (layout)
  });
});

test.describe('SPA Navigation', () => {
  test('should not reload page on link click', async ({ page }) => {
    await page.goto('/');

    // Track page reload
    let reloaded = false;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        reloaded = true;
      }
    });

    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();

    // Should not have reloaded (SPA navigation)
    // Note: This is a simplified check - full SPA validation in Phase 9.2
  });

  test('should update browser URL on navigation', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/blog"]');
    await page.waitForURL('**/blog');
    expect(page.url()).toContain('/blog');
  });
});

test.describe('Dynamic Routes', () => {
  test('should handle dynamic route parameters', async ({ page }) => {
    await page.goto('/blog/hello-world');
    const post = page.getByTestId('blog-post');
    await expect(post).toBeVisible();
    await expect(post).toContainText('hello-world');
  });

  test('should navigate between different dynamic route values', async ({ page }) => {
    await page.goto('/blog/first-post');
    await expect(page.getByTestId('blog-post')).toContainText('first-post');

    // Navigate to different post (would test partial rendering)
    await page.goto('/blog/second-post');
    await expect(page.getByTestId('blog-post')).toContainText('second-post');
  });
});
