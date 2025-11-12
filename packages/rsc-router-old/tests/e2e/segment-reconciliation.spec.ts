import { test, expect } from './fixtures';
import { markElement, elementWasPreserved } from './utils/rsc-helpers';

/**
 * Test suite for segment reconciliation
 * Verifies that layouts are preserved when navigating within the same layout group
 */

test.describe('Segment Reconciliation', () => {
  test.describe('Layout Preservation', () => {
    test('should preserve layout when navigating between pages in same layout group', async ({
      page,
    }) => {
      // Navigate to articles page
      await page.goto('/articles');
      await page.waitForLoadState('networkidle');

      // Mark the articles layout element
      await markElement(page, '[data-layout="articles"]', 'layout');

      // Navigate to a specific article (still within ArticlesLayout)
      await page.click('a[href="/articles/1"]');
      await page.waitForURL('/articles/1');

      // Verify the layout element was preserved (not re-rendered)
      const preserved = await elementWasPreserved(
        page,
        '[data-layout="articles"]',
        'layout'
      );
      expect(preserved).toBe(true);
    });

    test('should preserve root layout across all navigations', async ({
      page,
    }) => {
      // Navigate to home
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // Mark the root layout
      await markElement(page, '[data-layout="root"]', 'root-layout');

      // Navigate to dashboard (different layout group)
      await page.click('a[href="/dashboard"]');
      await page.waitForURL('/dashboard');

      // Root layout should still be preserved
      let preserved = await elementWasPreserved(
        page,
        '[data-layout="root"]',
        'root-layout'
      );
      expect(preserved).toBe(true);

      // Navigate to articles
      await page.click('a[href="/articles"]');
      await page.waitForURL('/articles');

      // Root layout should STILL be preserved
      preserved = await elementWasPreserved(
        page,
        '[data-layout="root"]',
        'root-layout'
      );
      expect(preserved).toBe(true);
    });

    test('should preserve state within layout during navigation', async ({
      page,
    }) => {
      await page.goto('/articles');
      await page.waitForLoadState('networkidle');

      // Add some state to the layout (e.g., scroll position or input value)
      // For this test, we'll use a data attribute as a proxy for state
      await page.evaluate(() => {
        const layout = document.querySelector('[data-layout="articles"]');
        if (layout) {
          (layout as any).testState = { count: 42 };
          layout.setAttribute('data-state-test', '42');
        }
      });

      // Navigate within the same layout
      await page.click('a[href="/articles/1"]');
      await page.waitForURL('/articles/1');

      // Verify state is preserved
      const statePreserved = await page.evaluate(() => {
        const layout = document.querySelector('[data-layout="articles"]');
        return layout?.getAttribute('data-state-test') === '42';
      });

      expect(statePreserved).toBe(true);
    });
  });

  test.describe('Layout Replacement', () => {
    test('should replace layout when navigating to different layout group', async ({
      page,
    }) => {
      // Navigate to dashboard
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle');

      // Mark dashboard layout
      await markElement(page, '[data-layout="dashboard"]', 'dashboard-layout');

      // Navigate to articles (different layout group)
      await page.click('a[href="/articles"]');
      await page.waitForURL('/articles');

      // Dashboard layout should be gone
      const dashboardExists = await page
        .locator('[data-layout="dashboard"]')
        .count();
      expect(dashboardExists).toBe(0);

      // Articles layout should be present
      const articlesExists = await page
        .locator('[data-layout="articles"]')
        .count();
      expect(articlesExists).toBeGreaterThan(0);
    });

    test('should unmount old layout components when changing layout groups', async ({
      page,
    }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle');

      // Check that dashboard layout is present
      const hasDashboardLayout = await page
        .locator('[data-layout="dashboard"]')
        .count();
      expect(hasDashboardLayout).toBeGreaterThan(0);

      // Navigate to articles
      await page.click('a[href="/articles"]');
      await page.waitForURL('/articles');

      // Dashboard layout should be unmounted
      const dashboardStillExists = await page
        .locator('[data-layout="dashboard"]')
        .count();
      expect(dashboardStillExists).toBe(0);
    });
  });

  test.describe('Nested Layouts', () => {
    test('should preserve parent layouts when child changes', async ({
      page,
    }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle');

      // Mark both root and dashboard layouts
      await markElement(page, '[data-layout="root"]', 'root');
      await markElement(page, '[data-layout="dashboard"]', 'dashboard');

      // Navigate to dashboard/analytics (same dashboard layout, different page)
      await page.click('a[href="/dashboard/analytics"]');
      await page.waitForURL('/dashboard/analytics');

      // Both layouts should be preserved
      const rootPreserved = await elementWasPreserved(
        page,
        '[data-layout="root"]',
        'root'
      );
      const dashboardPreserved = await elementWasPreserved(
        page,
        '[data-layout="dashboard"]',
        'dashboard'
      );

      expect(rootPreserved).toBe(true);
      expect(dashboardPreserved).toBe(true);
    });
  });

  test.describe('Article Navigation (Same Layout)', () => {
    test('should preserve ArticlesLayout when navigating between articles', async ({
      page,
    }) => {
      // Start at articles list
      await page.goto('/articles');
      await page.waitForLoadState('networkidle');

      // Mark the layout
      await markElement(page, '[data-layout="articles"]', 'articles');

      // Navigate to article 1
      await page.click('a[href="/articles/1"]');
      await page.waitForURL('/articles/1');

      // Layout should be preserved
      let preserved = await elementWasPreserved(
        page,
        '[data-layout="articles"]',
        'articles'
      );
      expect(preserved).toBe(true);

      // Navigate to article 2 (still within same layout)
      await page.goto('/articles/2');
      await page.waitForLoadState('networkidle');

      // Layout should STILL be preserved from our original marker
      preserved = await elementWasPreserved(
        page,
        '[data-layout="articles"]',
        'articles'
      );
      expect(preserved).toBe(true);
    });

    test('should only update route segment when navigating between articles', async ({
      page,
    }) => {
      await page.goto('/articles/1');
      await page.waitForLoadState('networkidle');

      // Verify we're on article 1
      await expect(page.locator('h2')).toContainText('Article 1');

      // Navigate to article 2
      await page.goto('/articles/2');
      await page.waitForLoadState('networkidle');

      // Verify we're now on article 2
      await expect(page.locator('h2')).toContainText('Article 2');

      // Verify the articles layout is still present (wasn't replaced)
      const layoutExists = await page
        .locator('[data-layout="articles"]')
        .count();
      expect(layoutExists).toBeGreaterThan(0);
    });
  });

  test.describe('Form State Preservation', () => {
    test('should preserve form state in layout during navigation', async ({
      page,
    }) => {
      // Navigate to dashboard/settings which has a form in the page
      await page.goto('/dashboard/settings');
      await page.waitForLoadState('networkidle');

      // If there's a form in the dashboard layout, interact with it
      // For this test, let's add a custom input to the dashboard layout
      await page.evaluate(() => {
        const layout = document.querySelector('[data-layout="dashboard"]');
        if (layout) {
          const input = document.createElement('input');
          input.setAttribute('data-test-input', 'true');
          input.value = 'test value';
          layout.appendChild(input);
        }
      });

      // Navigate within dashboard
      await page.click('a[href="/dashboard/analytics"]');
      await page.waitForURL('/dashboard/analytics');

      // Check if the input still exists and has the same value
      const inputValue = await page.evaluate(() => {
        const input = document.querySelector(
          '[data-test-input]'
        ) as HTMLInputElement;
        return input?.value;
      });

      expect(inputValue).toBe('test value');
    });
  });
});
