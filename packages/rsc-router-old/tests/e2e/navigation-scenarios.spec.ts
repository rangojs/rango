import { test, expect } from './fixtures';
import {
  captureNavigationRequests,
  parseHasParameter,
  getPartialRequests,
} from './utils/rsc-helpers';

/**
 * Test suite for various navigation scenarios
 * Tests different depth transitions and edge cases
 */

test.describe('Navigation Scenarios', () => {
  test.describe('Deep to Shallow Navigation', () => {
    test('should handle navigation from deep route to shallow route', async ({
      page,
    }) => {
      // Start at deep route: /articles/123
      await page.goto('/articles/123');
      await page.waitForLoadState('networkidle');

      // Navigate to shallow route: /articles
      const requests = await captureNavigationRequests(page, async () => {
        await page.click('a[href="/articles"]');
        await page.waitForURL('/articles');
      });

      // Should use partial navigation (no full reload)
      const partialRequests = getPartialRequests(requests);
      expect(partialRequests.length).toBeGreaterThan(0);

      // Should have _has parameter with segments
      const navigationRequest = partialRequests[0];
      expect(navigationRequest.hasParameter).not.toBeNull();

      const segments = parseHasParameter(navigationRequest.hasParameter);
      expect(segments.length).toBeGreaterThan(0);
    });

    test('should preserve ArticlesLayout when going from article to list', async ({
      page,
    }) => {
      await page.goto('/articles/456');
      await page.waitForLoadState('networkidle');

      // Verify we're on an article page
      await expect(page.locator('h2')).toContainText('Article 456');

      // Navigate to articles list
      await page.click('a[href="/articles"]');
      await page.waitForURL('/articles');

      // Verify we're on the list page
      await expect(page.locator('h1')).toContainText('Articles');

      // Verify ArticlesLayout is still present
      const layoutExists = await page
        .locator('[data-layout="articles"]')
        .count();
      expect(layoutExists).toBeGreaterThan(0);
    });
  });

  test.describe('Shallow to Deep Navigation', () => {
    test('should handle navigation from shallow route to deep route', async ({
      page,
    }) => {
      // Start at shallow route: /articles
      await page.goto('/articles');
      await page.waitForLoadState('networkidle');

      // Navigate to deep route: /articles/789
      const requests = await captureNavigationRequests(page, async () => {
        await page.click('a[href="/articles/789"]');
        await page.waitForURL('/articles/789');
      });

      // Should use partial navigation
      const partialRequests = getPartialRequests(requests);
      expect(partialRequests.length).toBeGreaterThan(0);

      // Should have _has parameter
      const navigationRequest = partialRequests[0];
      expect(navigationRequest.hasParameter).not.toBeNull();
    });

    test('should preserve ArticlesLayout when going from list to article', async ({
      page,
    }) => {
      await page.goto('/articles');
      await page.waitForLoadState('networkidle');

      // Add marker to layout
      await page.evaluate(() => {
        const layout = document.querySelector('[data-layout="articles"]');
        if (layout) {
          layout.setAttribute('data-marker', 'preserved');
        }
      });

      // Navigate to article
      await page.click('a[href="/articles/789"]');
      await page.waitForURL('/articles/789');

      // Verify marker is still there (layout wasn't re-rendered)
      const markerPresent = await page.evaluate(() => {
        const layout = document.querySelector('[data-layout="articles"]');
        return layout?.getAttribute('data-marker') === 'preserved';
      });

      expect(markerPresent).toBe(true);
    });
  });

  test.describe('Same Depth Navigation', () => {
    test('should handle navigation between sibling routes at same depth', async ({
      page,
    }) => {
      // Start at /dashboard
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle');

      // Navigate to /articles (same depth, different subtree)
      const requests = await captureNavigationRequests(page, async () => {
        await page.click('a[href="/articles"]');
        await page.waitForURL('/articles');
      });

      // Should use partial navigation
      const partialRequests = getPartialRequests(requests);
      expect(partialRequests.length).toBeGreaterThan(0);
    });

    test('should handle navigation between articles at same depth', async ({
      page,
    }) => {
      await page.goto('/articles/100');
      await page.waitForLoadState('networkidle');

      // Navigate to different article
      await page.goto('/articles/200');
      await page.waitForLoadState('networkidle');

      // Verify content changed
      await expect(page.locator('h2')).toContainText('Article 200');

      // Verify layout is still present
      const layoutExists = await page
        .locator('[data-layout="articles"]')
        .count();
      expect(layoutExists).toBeGreaterThan(0);
    });
  });

  test.describe('Cross-Layout Navigation', () => {
    test('should replace layout when navigating across layout boundaries', async ({
      page,
    }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle');

      // Verify dashboard layout exists
      let dashboardExists = await page
        .locator('[data-layout="dashboard"]')
        .count();
      expect(dashboardExists).toBeGreaterThan(0);

      // Navigate to articles (different layout)
      await page.click('a[href="/articles"]');
      await page.waitForURL('/articles');

      // Dashboard layout should be gone
      dashboardExists = await page.locator('[data-layout="dashboard"]').count();
      expect(dashboardExists).toBe(0);

      // Articles layout should be present
      const articlesExists = await page
        .locator('[data-layout="articles"]')
        .count();
      expect(articlesExists).toBeGreaterThan(0);
    });

    test('should handle navigation from nested route to different layout', async ({
      page,
    }) => {
      // Start at /dashboard/analytics (nested in dashboard layout)
      await page.goto('/dashboard/analytics');
      await page.waitForLoadState('networkidle');

      // Navigate to /articles (different layout tree)
      const requests = await captureNavigationRequests(page, async () => {
        await page.click('a[href="/articles"]');
        await page.waitForURL('/articles');
      });

      // Should use partial navigation even across layout boundaries
      const partialRequests = getPartialRequests(requests);
      expect(partialRequests.length).toBeGreaterThan(0);

      // Should have _has parameter indicating which segments client has
      const navigationRequest = partialRequests[0];
      const segments = parseHasParameter(navigationRequest.hasParameter);

      // Should include dashboard layout segment (which will be unmounted)
      // and the route segment from /dashboard/analytics
      expect(segments.length).toBeGreaterThan(0);
    });
  });

  test.describe('Root-Only Pages', () => {
    test('should handle navigation to page with only root layout', async ({
      page,
    }) => {
      // Start at a page with nested layouts
      await page.goto('/dashboard/analytics');
      await page.waitForLoadState('networkidle');

      // Navigate to /about (only uses root layout)
      await page.click('a[href="/about"]');
      await page.waitForURL('/about');

      // Verify we're on the about page
      await expect(page.locator('h1')).toContainText('About Us');

      // Dashboard layout should be gone
      const dashboardExists = await page
        .locator('[data-layout="dashboard"]')
        .count();
      expect(dashboardExists).toBe(0);

      // Root layout should still be present
      const rootExists = await page.locator('[data-layout="root"]').count();
      expect(rootExists).toBeGreaterThan(0);
    });

    test('should preserve root layout when navigating to root-only page', async ({
      page,
    }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle');

      // Mark root layout
      await page.evaluate(() => {
        const root = document.querySelector('[data-layout="root"]');
        if (root) {
          root.setAttribute('data-root-marker', 'preserved');
        }
      });

      // Navigate to /about
      await page.click('a[href="/about"]');
      await page.waitForURL('/about');

      // Verify root layout marker is preserved
      const rootPreserved = await page.evaluate(() => {
        const root = document.querySelector('[data-layout="root"]');
        return root?.getAttribute('data-root-marker') === 'preserved';
      });

      expect(rootPreserved).toBe(true);
    });
  });

  test.describe('Back/Forward Navigation', () => {
    test('should use partial navigation on browser back', async ({ page }) => {
      // Navigate through several pages
      await page.goto('/');
      await page.click('a[href="/dashboard"]');
      await page.waitForURL('/dashboard');
      await page.click('a[href="/articles"]');
      await page.waitForURL('/articles');

      // Capture requests when going back
      const requests = await captureNavigationRequests(page, async () => {
        await page.goBack();
        await page.waitForURL('/dashboard');
      });

      // Should use partial navigation (though browser might use cache)
      // At minimum, should not do a full page reload
      const documentRequests = requests.filter((r) => r.isDocumentRequest);
      expect(documentRequests.length).toBe(0);
    });

    test('should use partial navigation on browser forward', async ({
      page,
    }) => {
      // Navigate and go back
      await page.goto('/');
      await page.click('a[href="/dashboard"]');
      await page.waitForURL('/dashboard');
      await page.goBack();
      await page.waitForURL('/');

      // Capture requests when going forward
      const requests = await captureNavigationRequests(page, async () => {
        await page.goForward();
        await page.waitForURL('/dashboard');
      });

      // Should not do a full page reload
      const documentRequests = requests.filter((r) => r.isDocumentRequest);
      expect(documentRequests.length).toBe(0);
    });
  });

  test.describe('Error Cases', () => {
    test('should handle 404 navigation gracefully', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // Navigate to non-existent route
      await page.goto('/this-does-not-exist');

      // Should show 404 page
      await expect(page.locator('h1')).toContainText('404');
    });
  });

  test.describe('Multiple Rapid Navigations', () => {
    test('should handle rapid consecutive navigations', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // Rapidly navigate through pages
      await page.click('a[href="/dashboard"]');
      await page.click('a[href="/articles"]');
      await page.click('a[href="/about"]');

      // Wait for final navigation
      await page.waitForURL('/about');

      // Verify we ended up on the correct page
      await expect(page.locator('h1')).toContainText('About Us');
    });
  });
});
