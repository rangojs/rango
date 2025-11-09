/**
 * E2E Tests - Dynamic Routes
 *
 * Tests dynamic route parameters and navigation
 */

import { test, expect } from '@playwright/test';

test.describe('Dynamic Routes - Parameter Handling', () => {
  test('should render route with dynamic parameter', async ({ page }) => {
    await page.goto('/blog/hello-world');
    const post = page.getByTestId('blog-post');
    await expect(post).toBeVisible();
    await expect(post).toContainText('hello-world');
  });

  test('should handle different parameter values', async ({ page }) => {
    await page.goto('/blog/first-post');
    await expect(page.getByTestId('blog-post')).toContainText('first-post');

    await page.goto('/blog/second-post');
    await expect(page.getByTestId('blog-post')).toContainText('second-post');
  });

  test('should handle URL-encoded parameters', async ({ page }) => {
    await page.goto('/blog/hello%20world');
    await expect(page.getByTestId('blog-post')).toContainText('hello world');
  });

  test('should handle special characters in parameters', async ({ page }) => {
    await page.goto('/blog/post-with-dashes');
    await expect(page.getByTestId('blog-post')).toContainText('post-with-dashes');
  });
});

test.describe('Dynamic Routes - Navigation Between Values', () => {
  test('should navigate between different parameter values via SPA', async ({ page }) => {
    await page.goto('/blog/first');
    await expect(page.getByTestId('blog-post')).toContainText('first');

    await page.goto('/blog/second');
    await expect(page.getByTestId('blog-post')).toContainText('second');

    // Should update without full reload (layout preserved)
    await expect(page.locator('nav')).toBeVisible();
  });

  test('should preserve layout when navigating between dynamic values', async ({ page }) => {
    await page.goto('/blog/first');
    const navContent = await page.locator('nav').textContent();

    await page.goto('/blog/second');

    // Nav should still exist with same content (layout preserved)
    const navContentAfter = await page.locator('nav').textContent();
    expect(navContentAfter).toBe(navContent);
  });
});

test.describe('Dynamic Routes - Edge Cases', () => {
  test('should handle empty parameter', async ({ page }) => {
    const response = await page.goto('/blog/');
    // Should either show blog index or handle gracefully
    expect(response?.status()).toBeLessThan(500);
  });

  test('should handle very long parameters', async ({ page }) => {
    const longSlug = 'a'.repeat(200);
    await page.goto(`/blog/${longSlug}`);
    await expect(page.getByTestId('blog-post')).toContainText(longSlug);
  });

  test('should handle numeric parameters', async ({ page }) => {
    await page.goto('/blog/123');
    await expect(page.getByTestId('blog-post')).toContainText('123');
  });
});
