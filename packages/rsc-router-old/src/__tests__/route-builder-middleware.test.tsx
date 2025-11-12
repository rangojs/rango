/**
 * Tests for RouteBuilder.use() - Route-specific middleware
 * Following TDD: Tests define how middleware is stored and scoped
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('RouteBuilder.use() - Route-specific middleware', () => {
  describe('Basic middleware storage', () => {
    it('should store route-specific middleware', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const middleware1 = async () => {};

      router.route(routes).use(middleware1);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toContain(middleware1);
    });

    it('should store multiple middleware from single use() call', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const mw1 = async () => {};
      const mw2 = async () => {};
      const mw3 = async () => {};

      router.route(routes).use(mw1, mw2, mw3);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toHaveLength(3);
      expect(registered[0]?.middleware).toEqual([mw1, mw2, mw3]);
    });

    it('should store middleware from chained use() calls', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const mw1 = async () => {};
      const mw2 = async () => {};
      const mw3 = async () => {};

      router.route(routes).use(mw1).use(mw2).use(mw3);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toHaveLength(3);
      expect(registered[0]?.middleware).toEqual([mw1, mw2, mw3]);
    });

    it('should maintain middleware order', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const mw1 = async () => {};
      const mw2 = async () => {};

      router.route(routes).use(mw1).use(mw2);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware[0]).toBe(mw1);
      expect(registered[0]?.middleware[1]).toBe(mw2);
    });
  });

  describe('Middleware isolation between route groups', () => {
    it('should isolate middleware between different route groups', () => {
      const router = createRSCRouter();
      const blogRoutes = route({ index: '/blog' });
      const adminRoutes = route({ dashboard: '/admin' });
      const blogMw = async () => {};
      const adminMw = async () => {};

      router.route(blogRoutes).use(blogMw);
      router.route(adminRoutes).use(adminMw);

      const registered = router.getRegisteredRoutes();

      // Blog route should only have blogMw
      expect(registered[0]?.middleware).toContain(blogMw);
      expect(registered[0]?.middleware).not.toContain(adminMw);

      // Admin route should only have adminMw
      expect(registered[1]?.middleware).toContain(adminMw);
      expect(registered[1]?.middleware).not.toContain(blogMw);
    });

    it('should not affect global middleware', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const globalMw = async () => {};
      const routeMw = async () => {};

      router.use(globalMw);
      router.route(routes).use(routeMw);

      // Global middleware should remain separate
      expect(router.getGlobalMiddleware()).toContain(globalMw);
      expect(router.getGlobalMiddleware()).not.toContain(routeMw);

      // Route middleware should be scoped
      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toContain(routeMw);
      expect(registered[0]?.middleware).not.toContain(globalMw);
    });
  });

  describe('Chaining with route registration', () => {
    it('should allow use() after route() with prefix', () => {
      const router = createRSCRouter();
      const routes = route({ index: '/' });
      const middleware = async () => {};

      router.route('/blog', routes).use(middleware);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.prefix).toBe('/blog');
      expect(registered[0]?.middleware).toContain(middleware);
    });

    it('should allow use() after route() without prefix', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const middleware = async () => {};

      router.route(routes).use(middleware);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.prefix).toBeUndefined();
      expect(registered[0]?.middleware).toContain(middleware);
    });
  });

  describe('Empty middleware', () => {
    it('should handle routes with no middleware', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router.route(routes);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toEqual([]);
    });

    it('should handle empty use() call', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router.route(routes).use();

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toEqual([]);
    });
  });

  describe('Middleware with different signatures', () => {
    it('should accept async middleware', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const asyncMw = async () => {};

      router.route(routes).use(asyncMw);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toContain(asyncMw);
    });

    it('should accept sync middleware', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const syncMw = () => {};

      router.route(routes).use(syncMw);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toContain(syncMw);
    });

    it('should accept mixed async/sync middleware', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const asyncMw = async () => {};
      const syncMw = () => {};

      router.route(routes).use(asyncMw, syncMw);

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.middleware).toHaveLength(2);
    });
  });

  describe('Return value for chaining', () => {
    it('should return RouteBuilder instance for chaining', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      const builder = router.route(routes).use(async () => {});

      expect(builder).toBeDefined();
      expect(builder.use).toBeDefined();
      expect(builder.map).toBeDefined();
    });

    it('should maintain same builder through multiple use() calls', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      const builder1 = router.route(routes);
      const builder2 = builder1.use(async () => {});
      const builder3 = builder2.use(async () => {});

      // All should be the same builder instance
      expect(builder2).toBe(builder1);
      expect(builder3).toBe(builder1);
    });
  });
});
