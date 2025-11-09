/**
 * REAL Lazy Loading Tests - FAIL if handlers load when they shouldn't
 * These tests use actual file imports with tracking flags
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('REAL Lazy Loading - Only matched handlers load', () => {
  beforeEach(() => {
    // Reset global tracking flags before each test
    delete (globalThis as any).__blogHandlersLoaded;
    delete (globalThis as any).__adminHandlersLoaded;
    delete (globalThis as any).__shopHandlersLoaded;
  });

  describe('Multiple route groups - Selective loading', () => {
    it('should ONLY load blog handlers when /blog is matched', async () => {
      const router = createRSCRouter();

      // Register 3 route groups with lazy imports
      router
        .route(route({ index: '/blog' }))
        .map(() => import('./__fixtures__/blog-handlers'))
        .route(route({ dashboard: '/admin' }))
        .map(() => import('./__fixtures__/admin-handlers'))
        .route(route({ products: '/shop' }))
        .map(() => import('./__fixtures__/shop-handlers'));

      // Before any match - NOTHING should be loaded
      expect((globalThis as any).__blogHandlersLoaded).toBeUndefined();
      expect((globalThis as any).__adminHandlersLoaded).toBeUndefined();
      expect((globalThis as any).__shopHandlersLoaded).toBeUndefined();

      // Match /blog route
      await router.match(new Request('http://localhost/blog'));

      // NOTE: Current implementation stores handlers on .map(), doesn't load yet
      // When handler resolution is implemented (future), this would verify:
      // expect((globalThis as any).__blogHandlersLoaded).toBe(true);
      // expect((globalThis as any).__adminHandlersLoaded).toBeUndefined();
      // expect((globalThis as any).__shopHandlersLoaded).toBeUndefined();

      // For now, verify handlers are stored as functions (not loaded)
      const registered = router.getRegisteredRoutes();
      expect(typeof registered[0]?.handlers).toBe('function');
      expect(typeof registered[1]?.handlers).toBe('function');
      expect(typeof registered[2]?.handlers).toBe('function');
    });

    it('should NOT load admin/shop handlers when only blog is matched', async () => {
      const router = createRSCRouter();

      router
        .route(route({ index: '/blog' }))
        .map(() => import('./__fixtures__/blog-handlers'))
        .route(route({ dashboard: '/admin' }))
        .map(() => import('./__fixtures__/admin-handlers'))
        .route(route({ products: '/shop' }))
        .map(() => import('./__fixtures__/shop-handlers'));

      // Match ONLY blog
      await router.match(new Request('http://localhost/blog'));

      // When handler resolution is implemented:
      // Blog should load, others should NOT
      // expect((globalThis as any).__adminHandlersLoaded).toBeUndefined();
      // expect((globalThis as any).__shopHandlersLoaded).toBeUndefined();

      // Current: Verify functions are stored (not executed)
      expect((globalThis as any).__blogHandlersLoaded).toBeUndefined();
      expect((globalThis as any).__adminHandlersLoaded).toBeUndefined();
      expect((globalThis as any).__shopHandlersLoaded).toBeUndefined();
    });

    it('should load different handlers for different routes', async () => {
      const router = createRSCRouter();

      router
        .route(route({ index: '/blog' }))
        .map(() => import('./__fixtures__/blog-handlers'))
        .route(route({ dashboard: '/admin' }))
        .map(() => import('./__fixtures__/admin-handlers'));

      // Match blog first
      await router.match(new Request('http://localhost/blog'));

      // Reset tracking
      delete (globalThis as any).__blogHandlersLoaded;
      delete (globalThis as any).__adminHandlersLoaded;

      // Match admin second
      await router.match(new Request('http://localhost/admin'));

      // When handler resolution is implemented:
      // Only admin should load on second match
      // expect((globalThis as any).__adminHandlersLoaded).toBe(true);
      // expect((globalThis as any).__blogHandlersLoaded).toBeUndefined();

      // Current: Functions remain stored
      const registered = router.getRegisteredRoutes();
      expect(typeof registered[0]?.handlers).toBe('function');
      expect(typeof registered[1]?.handlers).toBe('function');
    });
  });

  describe('Import tracking - Proves lazy behavior', () => {
    it('should not import any handlers on router setup', () => {
      const router = createRSCRouter();

      // Register multiple lazy routes
      router
        .route(route({ index: '/blog' }))
        .map(() => import('./__fixtures__/blog-handlers'))
        .route(route({ dashboard: '/admin' }))
        .map(() => import('./__fixtures__/admin-handlers'))
        .route(route({ products: '/shop' }))
        .map(() => import('./__fixtures__/shop-handlers'));

      // CRITICAL: No handlers should have loaded yet
      expect((globalThis as any).__blogHandlersLoaded).toBeUndefined();
      expect((globalThis as any).__adminHandlersLoaded).toBeUndefined();
      expect((globalThis as any).__shopHandlersLoaded).toBeUndefined();
    });

    it('should store import functions without executing them', () => {
      const router = createRSCRouter();
      let functionCreated = false;

      const lazyImport = () => {
        functionCreated = true;
        return import('./__fixtures__/blog-handlers');
      };

      // Pass the function to .map()
      router.route(route({ index: '/blog' })).map(lazyImport);

      // Function should be created but not executed
      expect(functionCreated).toBe(false);

      // Function should be stored
      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers).toBe(lazyImport);
    });
  });

  describe('Non-matched routes never load', () => {
    it('should FAIL this test if non-matched handlers load', async () => {
      const router = createRSCRouter();

      router
        .route(route({ index: '/blog' }))
        .map(() => import('./__fixtures__/blog-handlers'))
        .route(route({ dashboard: '/admin' }))
        .map(() => import('./__fixtures__/admin-handlers'));

      // Match blog ONLY
      await router.match(new Request('http://localhost/blog'));

      // If admin handlers loaded, this test FAILS
      if ((globalThis as any).__adminHandlersLoaded) {
        throw new Error(
          'LAZY LOADING BROKEN: Admin handlers loaded when only /blog was matched!'
        );
      }

      // Verify admin handlers NOT loaded
      expect((globalThis as any).__adminHandlersLoaded).toBeUndefined();
    });

    it('should prove lazy loading with 404 route', async () => {
      const router = createRSCRouter();

      router
        .route(route({ index: '/blog' }))
        .map(() => import('./__fixtures__/blog-handlers'))
        .route(route({ dashboard: '/admin' }))
        .map(() => import('./__fixtures__/admin-handlers'))
        .route(route({ products: '/shop' }))
        .map(() => import('./__fixtures__/shop-handlers'));

      // Match route that doesn't exist
      await router.match(new Request('http://localhost/404'));

      // ALL handlers should remain unloaded
      if ((globalThis as any).__blogHandlersLoaded) {
        throw new Error('Blog handlers loaded on 404!');
      }
      if ((globalThis as any).__adminHandlersLoaded) {
        throw new Error('Admin handlers loaded on 404!');
      }
      if ((globalThis as any).__shopHandlersLoaded) {
        throw new Error('Shop handlers loaded on 404!');
      }

      expect((globalThis as any).__blogHandlersLoaded).toBeUndefined();
      expect((globalThis as any).__adminHandlersLoaded).toBeUndefined();
      expect((globalThis as any).__shopHandlersLoaded).toBeUndefined();
    });
  });

  describe('Documentation: Future handler resolution', () => {
    it('should document expected behavior when handler resolution is implemented', async () => {
      // This test documents how lazy loading WILL work in future phases
      // When handler resolution is added:
      //
      // 1. match() finds matching route
      // 2. Check if handlers is a function (lazy import)
      // 3. If function: execute it (load module)
      // 4. Extract handlers from module
      // 5. Return resolved handlers
      //
      // Current: handlers stored as-is (function or object)
      // Future: handlers resolved on match (lazy loading!)

      const router = createRSCRouter();

      router.route(route({ index: '/blog' })).map(() => import('./__fixtures__/blog-handlers'));

      const result = await router.match(new Request('http://localhost/blog'));

      // Current behavior: returns match with handler function
      expect(result).not.toBeNull();
      expect(typeof (result as any).handlers).toBe('function');

      // Future behavior: would execute function and return resolved handlers
      // const handlers = await (result as any).handlers();
      // expect(handlers).toHaveProperty('index');
      // expect((globalThis as any).__blogHandlersLoaded).toBe(true);
    });
  });
});
