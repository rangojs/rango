/**
 * Tests for map() Helper Function - Type-safe handler definitions in separate files
 * Following TDD: Tests define the map(routes, handlers) helper API
 */

import { describe, it, expect } from 'vitest';
import { route, map } from '../route-definition';

describe('map() Helper Function - Lazy loading support', () => {
  describe('Basic map() helper', () => {
    it('should accept route map and handlers object', () => {
      const routes = route({
        home: '/',
        about: '/about',
      });

      const handlers = map(routes, {
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
      });

      expect(handlers).toBeDefined();
      expect(handlers.home).toBeDefined();
      expect(handlers.about).toBeDefined();
    });

    it('should return handlers object unchanged', () => {
      const routes = route({ home: '/' });

      const homeHandler = () => <div>Home</div>;
      const handlers = map(routes, {
        home: homeHandler,
      });

      expect(handlers.home).toBe(homeHandler);
    });

    it('should preserve symbols in handlers', () => {
      const routes = route({ home: '/' });
      const Layout = () => <div>Layout</div>;

      const handlers = map(routes, {
        [route.layout]: Layout,
        home: () => <div>Home</div>,
      });

      expect(handlers[route.layout]).toBe(Layout);
    });
  });

  describe('Type safety with map() helper', () => {
    it('should enforce handler keys match route names', () => {
      const routes = route({
        home: '/',
        about: '/about',
      });

      // This should compile
      const handlers = map(routes, {
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
      });

      expect(handlers).toBeDefined();
    });

    it('should allow partial handler mapping', () => {
      const routes = route({
        home: '/',
        about: '/about',
        contact: '/contact',
      });

      // Mapping only some routes should be OK
      const handlers = map(routes, {
        home: () => <div>Home</div>,
        // about and contact omitted
      });

      expect(handlers).toBeDefined();
      expect(handlers.home).toBeDefined();
    });
  });

  describe('Nested routes with map() helper', () => {
    it('should support nested route structures', () => {
      const routes = route({
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
      });

      const handlers = map(routes, {
        blog: {
          index: () => <div>Blog Index</div>,
          post: () => <div>Blog Post</div>,
        },
      });

      expect(handlers.blog).toBeDefined();
    });

    it('should support symbols in nested handlers', () => {
      const routes = route({
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
      });

      const BlogLayout = () => <div>BlogLayout</div>;

      const handlers = map(routes, {
        blog: {
          [route.layout]: BlogLayout,
          index: () => <div>Index</div>,
          post: () => <div>Post</div>,
        },
      });

      expect(handlers.blog[route.layout]).toBe(BlogLayout);
    });
  });

  describe('Usage with router', () => {
    it('should work with router.route().map()', async () => {
      const { createRSCRouter } = await import('../create-router');

      const router = createRSCRouter();
      const routes = route({ home: '/' });

      const handlers = map(routes, {
        home: () => <div>Home</div>,
      });

      router.route(routes).map(handlers);

      const result = await router.match(new Request('http://localhost/'));
      expect(result).not.toBeNull();
    });
  });

  describe('Export for separate files', () => {
    it('should be exported from route-definition module', () => {
      expect(map).toBeDefined();
      expect(typeof map).toBe('function');
    });

    it('should enable separate handler files pattern', () => {
      // This pattern should work:
      // File: routes.ts
      const routes = route({ home: '/', about: '/about' });

      // File: handlers.ts
      const handlers = map(routes, {
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
      });

      // File: app.ts
      // router.route(routes).map(handlers);

      expect(routes).toBeDefined();
      expect(handlers).toBeDefined();
    });
  });

  describe('Per-route layouts with map() helper', () => {
    it('should support per-route layouts', () => {
      const routes = route({
        home: '/',
        about: '/about',
      });

      const handlers = map(routes, {
        [route.layout]: {
          home: () => <div>HomeLayout</div>,
          about: () => <div>AboutLayout</div>,
        },
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
      });

      expect(handlers[route.layout]).toBeDefined();
    });

    it('should support layout arrays', () => {
      const routes = route({ home: '/' });
      const L1 = () => <div>L1</div>;
      const L2 = () => <div>L2</div>;

      const handlers = map(routes, {
        [route.layout]: [L1, L2],
        home: () => <div>Home</div>,
      });

      expect(handlers[route.layout]).toEqual([L1, L2]);
    });
  });
});
