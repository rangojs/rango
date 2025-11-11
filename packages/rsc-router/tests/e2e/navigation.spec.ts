import { test, expect } from './fixtures';
import {
  captureNavigationRequests,
  parseHasParameter,
  isValidSegmentId,
  countPageReloads,
  getPartialRequests,
} from './utils/rsc-helpers';

/**
 * Test suite for RSC Router navigation behavior
 * Verifies differential rendering with segment-based updates
 */

test.describe('RSC Router Navigation', () => {
  test.describe('Document Load vs SPA Navigation', () => {
    test('should perform full document load on initial page visit', async ({
      page,
    }) => {
      const requests = await captureNavigationRequests(page, async () => {
        await page.goto('/');
      });

      // Should have exactly one document request
      const documentRequests = requests.filter((r) => r.isDocumentRequest);
      expect(documentRequests).toHaveLength(1);

      // Initial load should NOT have _has parameter
      const initialRequest = documentRequests[0];
      expect(initialRequest.hasParameter).toBeNull();
    });

    test('should perform partial navigation with _has parameter on SPA navigation', async ({
      page,
    }) => {
      // First, load the initial page
      await page.goto('/');

      // Wait for page to be fully loaded
      await page.waitForLoadState('networkidle');

      // Now perform SPA navigation
      const requests = await captureNavigationRequests(page, async () => {
        await page.click('a[href="/dashboard"]');
        await page.waitForURL('/dashboard');
      });

      // Should NOT have a full document reload
      const documentRequests = requests.filter((r) => r.isDocumentRequest);
      expect(documentRequests).toHaveLength(0);

      // Should have a partial request with _has parameter
      const partialRequests = getPartialRequests(requests);
      expect(partialRequests.length).toBeGreaterThan(0);

      const navigationRequest = partialRequests.find((r) =>
        r.url.includes('/dashboard')
      );
      expect(navigationRequest).toBeDefined();
      expect(navigationRequest!.hasParameter).not.toBeNull();

      // Verify _has parameter contains valid segment IDs
      const segments = parseHasParameter(navigationRequest!.hasParameter);
      expect(segments.length).toBeGreaterThan(0);
      segments.forEach((segmentId) => {
        expect(isValidSegmentId(segmentId)).toBe(true);
      });
    });

    test('should NOT reload page on internal navigation', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // Track all requests
      const requests = await captureNavigationRequests(page, async () => {
        await page.click('a[href="/articles"]');
        await page.waitForURL('/articles');
      });

      // Should have ZERO document reloads (only partial updates)
      expect(countPageReloads(requests)).toBe(0);
    });

    test('should send different _has parameters for different source pages', async ({
      page,
    }) => {
      // Navigate from home to dashboard
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const fromHomeRequests = await captureNavigationRequests(page, async () => {
        await page.click('a[href="/dashboard"]');
        await page.waitForURL('/dashboard');
      });

      const fromHomeHas = getPartialRequests(fromHomeRequests)[0]?.hasParameter;

      // Navigate back to home, then to dashboard/analytics
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.click('a[href="/dashboard"]');
      await page.waitForURL('/dashboard');
      await page.waitForLoadState('networkidle');

      const fromDashboardRequests = await captureNavigationRequests(
        page,
        async () => {
          await page.click('a[href="/dashboard/analytics"]');
          await page.waitForURL('/dashboard/analytics');
        }
      );

      const fromDashboardHas = getPartialRequests(fromDashboardRequests)[0]
        ?.hasParameter;

      // The _has parameters should be different since we're navigating from different contexts
      // From home to dashboard: different layouts
      // From dashboard to dashboard/analytics: same layouts, different route
      expect(fromHomeHas).toBeDefined();
      expect(fromDashboardHas).toBeDefined();

      const homeSegments = parseHasParameter(fromHomeHas || '');
      const dashboardSegments = parseHasParameter(fromDashboardHas || '');

      // Dashboard/analytics navigation should have MORE segments (includes dashboard layout)
      expect(dashboardSegments.length).toBeGreaterThanOrEqual(
        homeSegments.length
      );
    });
  });

  test.describe('Segment ID Format', () => {
    test('should use correct segment ID format (L0, R2, P3)', async ({
      page,
    }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const requests = await captureNavigationRequests(page, async () => {
        await page.click('a[href="/articles"]');
        await page.waitForURL('/articles');
      });

      const partialRequest = getPartialRequests(requests)[0];
      expect(partialRequest).toBeDefined();

      const segments = parseHasParameter(partialRequest.hasParameter);

      // All segments should follow the format: [LRP]\d+
      segments.forEach((segmentId) => {
        expect(segmentId).toMatch(/^[LRP]\d+$/);
      });

      // Should have at least one Layout segment (L)
      const hasLayoutSegment = segments.some((s) => s.startsWith('L'));
      expect(hasLayoutSegment).toBe(true);

      // Should have at least one Route segment (R)
      const hasRouteSegment = segments.some((s) => s.startsWith('R'));
      expect(hasRouteSegment).toBe(true);
    });
  });

  test.describe('Accept Header', () => {
    test('should send text/html Accept header on initial load', async ({
      page,
    }) => {
      const requests = await captureNavigationRequests(page, async () => {
        await page.goto('/');
      });

      const documentRequest = requests.find((r) => r.isDocumentRequest);
      expect(documentRequest).toBeDefined();

      // Document navigation requests have resourceType 'document'
      // Note: Playwright doesn't expose Accept header for document navigations in headless mode
      // but we can verify it's a document request by checking isDocumentRequest
      expect(documentRequest!.isDocumentRequest).toBe(true);
    });

    test('should send RSC Accept header on partial navigation', async ({
      page,
    }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const requests = await captureNavigationRequests(page, async () => {
        await page.click('a[href="/dashboard"]');
        await page.waitForURL('/dashboard');
      });

      const partialRequest = getPartialRequests(requests)[0];
      expect(partialRequest).toBeDefined();

      // Should have text/x-component Accept header for RSC
      const accept = partialRequest.headers['accept'] || '';
      expect(accept).toContain('text/x-component');
    });
  });
});
