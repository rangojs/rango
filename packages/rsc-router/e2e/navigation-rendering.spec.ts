/**
 * E2E Test - Navigation Actually Renders
 *
 * CRITICAL: This test validates that clicking a link actually
 * renders the new page content in the browser.
 */

import { test, expect } from '@playwright/test';

test.describe('Navigation Rendering - CRITICAL', () => {
  test('should render new page content after link click', async ({ page }) => {
    // Start on home page
    await page.goto('/');
    await expect(page.getByTestId('home-page')).toBeVisible();
    await expect(page.getByTestId('about-page')).not.toBeVisible();

    // Click link to about page
    await page.click('a[href="/about"]');

    // CRITICAL: About page should now be visible
    await expect(page.getByTestId('about-page')).toBeVisible();

    // Home page should NOT be visible
    await expect(page.getByTestId('home-page')).not.toBeVisible();

    // URL should have updated
    expect(page.url()).toContain('/about');
  });

  test('should render blog post content after navigation', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/blog"]');

    // Blog index should be visible
    await expect(page.getByTestId('blog-index')).toBeVisible();
  });

  test('should render dynamic route content', async ({ page }) => {
    await page.goto('/blog/hello-world');

    // Blog post should be visible with correct slug
    const post = page.getByTestId('blog-post');
    await expect(post).toBeVisible();
    await expect(post).toContainText('hello-world');
  });

  test('should update content when navigating between dynamic routes', async ({ page }) => {
    await page.goto('/blog/first');
    await expect(page.getByTestId('blog-post')).toContainText('first');

    await page.goto('/blog/second');
    await expect(page.getByTestId('blog-post')).toContainText('second');
    await expect(page.getByTestId('blog-post')).not.toContainText('first');
  });
});
