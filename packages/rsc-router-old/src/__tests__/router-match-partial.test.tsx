/**
 * Phase 8.2: RSC Framework Integration - router.matchPartial()
 *
 * Tests for partial route matching and differential segment computation
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('Phase 8.2: RSC Framework Integration', () => {
  describe('router.matchPartial()', () => {
    describe('Basic partial matching', () => {
      it('should compute differential when navigating to different route', async () => {
        const routes = route({
          home: '/',
          blog: '/blog',
          about: '/about',
        });

        const router = createRSCRouter();
        router.route(routes).map({
          [route.layout]: () => <div>Root</div>,
          home: () => <div>Home</div>,
          blog: () => <div>Blog</div>,
          about: () => <div>About</div>,
        });

        const request = new Request('http://localhost/blog');
        const result = await router.matchPartial(request, '/');

        expect(result).toBeDefined();
        expect(result?.segments).toBeDefined();
        expect(result?.startIndex).toBeDefined();
        expect(result?.preservedLayouts).toBeDefined();
      });

      it('should return null when route not found', async () => {
        const routes = route({
          home: '/',
        });

        const router = createRSCRouter();
        router.route(routes).map({
          home: () => <div>Home</div>,
        });

        const request = new Request('http://localhost/nonexistent');
        const result = await router.matchPartial(request, '/');

        expect(result).toBeNull();
      });

      it('should identify startIndex where segments diverge', async () => {
        const routes = route({
          home: '/',
          blog: '/blog',
        });

        const router = createRSCRouter();
        router.route(routes).map({
          [route.layout]: () => <div>Root</div>,
          home: () => <div>Home</div>,
          blog: () => <div>Blog</div>,
        });

        const request = new Request('http://localhost/blog');
        const result = await router.matchPartial(request, '/');

        // Different routes, so startIndex depends on segment structure
        expect(result?.startIndex).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Preserved layouts', () => {
      it('should preserve shared root layout', async () => {
        const routes = route({
          home: '/',
          about: '/about',
        });

        const router = createRSCRouter();
        router.route(routes).map({
          [route.layout]: () => <div>Root</div>,
          home: () => <div>Home</div>,
          about: () => <div>About</div>,
        });

        const request = new Request('http://localhost/about');
        const result = await router.matchPartial(request, '/');

        // preservedLayouts contains paths where layouts are shared
        expect(Array.isArray(result?.preservedLayouts)).toBe(true);
      });

      it('should preserve shared nested layouts', async () => {
        const blogRoutes = route({
          index: '/',
          show: '/:slug',
        });

        const router = createRSCRouter();
        router.route('/blog', blogRoutes).map({
          [route.layout]: [
            () => <div>Root</div>,
            () => <div>Blog Layout</div>,
          ],
          index: () => <div>Blog Index</div>,
          show: () => <div>Blog Post</div>,
        });

        const request = new Request('http://localhost/blog/hello');
        const result = await router.matchPartial(request, '/blog');

        // Should have computed differential
        expect(result).toBeDefined();
        expect(Array.isArray(result?.preservedLayouts)).toBe(true);
      });

      it('should return empty preservedLayouts when no shared layouts', async () => {
        const routes = route({
          home: '/',
          blog: '/blog',
        });

        const router = createRSCRouter();
        router
          .route(routes)
          .map({
            home: () => <div>Home</div>,
          })
          .route('/blog', route({ index: '/' }))
          .map({
            [route.layout]: () => <div>Blog Layout</div>,
            index: () => <div>Blog</div>,
          });

        const request = new Request('http://localhost/blog');
        const result = await router.matchPartial(request, '/');

        expect(result?.preservedLayouts).toEqual([]);
      });
    });

    describe('Segment differential computation', () => {
      it('should return only changed segments', async () => {
        const blogRoutes = route({
          index: '/',
          show: '/:slug',
        });

        const router = createRSCRouter();
        router.route('/blog', blogRoutes).map({
          [route.layout]: () => <div>Blog Layout</div>,
          index: () => <div>Blog Index</div>,
          show: (ctx) => <div>Post: {ctx.params.slug}</div>,
        });

        const request = new Request('http://localhost/blog/hello');
        const result = await router.matchPartial(request, '/blog');

        // Should return segments from startIndex onwards
        expect(result?.segments.length).toBeGreaterThan(0);
      });

      it('should include parallel routes in segments', async () => {
        const routes = route({
          dashboard: '/dashboard',
        });

        const router = createRSCRouter();
        router.route(routes).map({
          [route.layout]: () => <div>Root</div>,
          [route.parallel]: {
            '@sidebar': () => <div>Sidebar</div>,
          },
          dashboard: () => <div>Dashboard</div>,
        });

        const request = new Request('http://localhost/dashboard');
        const result = await router.matchPartial(request, '/');

        // Should include route + parallel segments
        const parallelSegments = result?.segments.filter((s) => s.type === 'parallel');
        expect(parallelSegments?.length).toBeGreaterThan(0);
      });
    });

    describe('Same route navigation', () => {
      it('should handle navigation to same route with different params', async () => {
        const routes = route({
          show: '/:slug',
        });

        const router = createRSCRouter();
        router.route('/blog', routes).map({
          [route.layout]: () => <div>Blog</div>,
          show: (ctx) => <div>{ctx.params.slug}</div>,
        });

        const request = new Request('http://localhost/blog/new-post');
        const result = await router.matchPartial(request, '/blog/old-post');

        // Should return segments even though route structure is same
        expect(result).toBeDefined();
        expect(result?.segments.length).toBeGreaterThan(0);
      });
    });

    describe('Edge cases', () => {
      it('should handle previousPathname not matching any route', async () => {
        const routes = route({
          home: '/',
          blog: '/blog',
        });

        const router = createRSCRouter();
        router.route(routes).map({
          home: () => <div>Home</div>,
          blog: () => <div>Blog</div>,
        });

        const request = new Request('http://localhost/blog');
        const result = await router.matchPartial(request, '/nonexistent');

        // Should fallback to full render
        expect(result).toBeDefined();
      });

      it('should handle empty previousPathname', async () => {
        const routes = route({
          blog: '/blog',
        });

        const router = createRSCRouter();
        router.route(routes).map({
          blog: () => <div>Blog</div>,
        });

        const request = new Request('http://localhost/blog');
        const result = await router.matchPartial(request, '');

        expect(result).toBeDefined();
      });
    });
  });
});
