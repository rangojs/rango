/**
 * E2E Tests - Error Handling
 *
 * Tests error scenarios and 404 handling
 */

import { test, expect } from '@playwright/test';

test.describe('Error Handling - 404 Pages', () => {
  test('should show 404 for non-existent routes', async ({ page }) => {
    const response = await page.goto('/this-does-not-exist');
    expect(response?.status()).toBe(404);
  });

  test('should display 404 content', async ({ page }) => {
    await page.goto('/nonexistent');
    await expect(page.locator('h1')).toContainText('404');
  });

  test('should provide link to home from 404 page', async ({ page }) => {
    await page.goto('/nonexistent');
    const homeLink = page.locator('a[href="/"]');
    await expect(homeLink).toBeVisible();

    await homeLink.click();
    await expect(page.getByTestId('home-page')).toBeVisible();
  });
});

test.describe('Error Handling - Invalid Parameters', () => {
  test('should handle invalid dynamic route parameters gracefully', async ({ page }) => {
    const response = await page.goto('/blog/../../etc/passwd');
    // Should not crash, either show 404 or sanitized content
    expect(response?.status()).toBeLessThan(500);
  });

  test('should handle very long parameter values', async ({ page }) => {
    const longParam = 'a'.repeat(1000);
    const response = await page.goto(`/blog/${longParam}`);
    expect(response?.status()).toBeLessThan(500);
  });
});

test.describe('Error Handling - Navigation Errors', () => {
  test('should handle navigation to 404 after valid page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('home-page')).toBeVisible();

    const response = await page.goto('/invalid');
    expect(response?.status()).toBe(404);
  });

  test('should recover from 404 by navigating to valid route', async ({ page }) => {
    await page.goto('/invalid');
    expect(page.url()).toContain('/invalid');

    await page.goto('/');
    await expect(page.getByTestId('home-page')).toBeVisible();
  });
});
