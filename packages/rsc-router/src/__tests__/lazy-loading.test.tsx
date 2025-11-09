/**
 * Tests for Lazy Handler Loading - Dynamic imports
 * Following TDD: Tests define lazy loading behavior
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('Lazy Handler Loading', () => {
  describe('Dynamic import support', () => {
    it('should accept function returning import', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/', about: '/about' });

      // Should accept lazy import function
      router.route(routes).map(() => import('./__fixtures__/mock-handlers'));

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers).toBeDefined();
    });

    it('should store lazy import function', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const lazyImport = () => import('./__fixtures__/mock-handlers');

      router.route(routes).map(lazyImport);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers).toBe(lazyImport);
    });

    it('should work with inline arrow function', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router
        .route(routes)
        .map(() => import('./__fixtures__/mock-handlers'));

      expect(router.getRegisteredRoutes()).toHaveLength(1);
    });
  });

  describe('Lazy import with middleware', () => {
    it('should allow middleware before lazy handlers', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router
        .route(routes)
        .use(async (ctx, next) => {
          await next();
        })
        .map(() => import('./__fixtures__/mock-handlers'));

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toHaveLength(1);
      expect(registered[0]?.handlers).toBeDefined();
    });
  });

  describe('Multiple route groups with lazy loading', () => {
    it('should support different lazy imports per route group', () => {
      const router = createRSCRouter();
      const blogRoutes = route({ index: '/blog' });
      const adminRoutes = route({ dashboard: '/admin' });

      router
        .route(blogRoutes)
        .map(() => import('./__fixtures__/mock-handlers'))
        .route(adminRoutes)
        .map(() => import('./__fixtures__/mock-handlers'));

      const registered = router.getRegisteredRoutes();
      expect(registered).toHaveLength(2);
      expect(registered[0]?.handlers).toBeDefined();
      expect(registered[1]?.handlers).toBeDefined();
    });
  });

  describe('Lazy loading philosophy', () => {
    it('should not execute import on registration', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      let importExecuted = false;

      const lazyImport = () => {
        importExecuted = true;
        return import('./__fixtures__/mock-handlers');
      };

      // Register with lazy import
      router.route(routes).map(lazyImport);

      // Import should NOT have executed yet
      expect(importExecuted).toBe(false);
    });

    it('should store import function for later execution', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      const lazyImport = () => import('./__fixtures__/mock-handlers');

      router.route(routes).map(lazyImport);

      const registered = router.getRegisteredRoutes();
      // Function should be stored
      expect(typeof registered[0]?.handlers).toBe('function');
    });
  });

  describe('Documentation examples', () => {
    it('should support design doc example pattern', () => {
      const router = createRSCRouter();
      const blogRoutes = route({
        index: '/',
        show: '/:slug',
      });

      // From design doc:
      router.route('/blog', blogRoutes).map(() => import('./__fixtures__/mock-handlers'));

      expect(router.getRegisteredRoutes()).toHaveLength(1);
    });

    it('should support middleware + lazy handlers pattern', () => {
      const router = createRSCRouter();
      const blogRoutes = route({ index: '/' });

      // Complete pattern with regular middleware + lazy handlers
      router
        .route('/blog', blogRoutes)
        .use(async (ctx, next) => await next())  // Regular middleware
        .map(() => import('./__fixtures__/mock-handlers'));  // Lazy handlers

      expect(router.getRegisteredRoutes()).toHaveLength(1);
    });
  });
});
