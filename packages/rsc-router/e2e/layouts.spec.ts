/**
 * E2E Tests - Layouts
 *
 * Tests layout persistence and nesting
 */

import { test, expect } from '@playwright/test';

test.describe('Layouts - Persistence', () => {
  test('should preserve layout across route changes', async ({ page }) => {
    await page.goto('/');

    // Get layout content
    const nav = page.locator('nav');
    const navContent = await nav.textContent();

    // Navigate to different route
    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();

    // Layout should still exist
    await expect(nav).toBeVisible();
    expect(await nav.textContent()).toBe(navContent);
  });

  test('should maintain layout state during navigation', async ({ page }) => {
    await page.goto('/');

    // Layout (nav) should be present
    await expect(page.locator('nav')).toBeVisible();

    // Navigate multiple times
    await page.click('a[href="/about"]');
    await expect(page.locator('nav')).toBeVisible();

    await page.click('a[href="/blog"]');
    await expect(page.locator('nav')).toBeVisible();

    await page.click('a[href="/dashboard"]');
    await expect(page.locator('nav')).toBeVisible();

    // Layout persists through all navigations
  });
});

test.describe('Layouts - Content Rendering', () => {
  test('should render page content within layout', async ({ page }) => {
    await page.goto('/');

    // Layout should contain nav
    await expect(page.locator('nav')).toBeVisible();

    // Layout should contain page content
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('should update content while preserving layout', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('home-page')).toBeVisible();

    await page.click('a[href="/about"]');
    await expect(page.getByTestId('about-page')).toBeVisible();
    await expect(page.getByTestId('home-page')).not.toBeVisible();

    // Nav (layout) still visible
    await expect(page.locator('nav')).toBeVisible();
  });
});

test.describe('Layouts - Outlet Rendering', () => {
  test('should render content in Outlet location', async ({ page }) => {
    await page.goto('/');

    // Main element should contain page content (rendered via Outlet)
    const main = page.locator('main');
    await expect(main).toBeVisible();
    await expect(main.getByTestId('home-page')).toBeVisible();
  });

  test('should update Outlet content on navigation', async ({ page }) => {
    await page.goto('/');
    const main = page.locator('main');
    await expect(main.getByTestId('home-page')).toBeVisible();

    await page.click('a[href="/about"]');
    await expect(main.getByTestId('about-page')).toBeVisible();
    await expect(main.getByTestId('home-page')).not.toBeVisible();
  });
});
