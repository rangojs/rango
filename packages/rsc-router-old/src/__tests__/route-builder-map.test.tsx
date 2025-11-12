/**
 * Tests for RouteBuilder.map() - Handler mapping
 * Following TDD: Tests define how handlers are mapped to routes
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('RouteBuilder.map() - Handler mapping', () => {
  describe('Basic handler mapping', () => {
    it('should map simple route handlers', () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        about: '/about',
      });

      router.route(routes).map({
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers).toBeDefined();
    });

    it('should return router instance for chaining', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      const result = router.route(routes).map({
        home: () => <div>Home</div>,
      });

      expect(result).toBe(router);
    });

    it('should allow registering multiple route groups', () => {
      const router = createRSCRouter();
      const mainRoutes = route({ home: '/' });
      const blogRoutes = route({ index: '/blog' });

      router
        .route(mainRoutes)
        .map({ home: () => <div>Home</div> })
        .route(blogRoutes)
        .map({ index: () => <div>Blog</div> });

      const registered = router.getRegisteredRoutes();
      expect(registered).toHaveLength(2);
    });
  });

  describe('Handler storage', () => {
    it('should store handlers in registered route', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/', about: '/about' });

      const homeHandler = () => <div>Home</div>;
      const aboutHandler = () => <div>About</div>;

      router.route(routes).map({
        home: homeHandler,
        about: aboutHandler,
      });

      const registered = router.getRegisteredRoutes();
      const handlers = registered[0]?.handlers;

      expect(handlers?.home).toBe(homeHandler);
      expect(handlers?.about).toBe(aboutHandler);
    });

    it('should store handlers separately for different route groups', () => {
      const router = createRSCRouter();
      const blogRoutes = route({ index: '/blog' });
      const adminRoutes = route({ dashboard: '/admin' });

      const blogHandler = () => <div>Blog</div>;
      const adminHandler = () => <div>Admin</div>;

      router.route(blogRoutes).map({ index: blogHandler });
      router.route(adminRoutes).map({ dashboard: adminHandler });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers?.index).toBe(blogHandler);
      expect(registered[1]?.handlers?.dashboard).toBe(adminHandler);
    });
  });

  describe('Nested route handlers', () => {
    it('should map handlers for nested routes', () => {
      const router = createRSCRouter();
      const routes = route({
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
      });

      router.route(routes).map({
        blog: {
          index: () => <div>Blog Index</div>,
          post: () => <div>Blog Post</div>,
        },
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers).toBeDefined();
    });

    it('should map deeply nested handlers', () => {
      const router = createRSCRouter();
      const routes = route({
        admin: {
          users: {
            list: '/admin/users',
            detail: '/admin/users/:id',
          },
        },
      });

      router.route(routes).map({
        admin: {
          users: {
            list: () => <div>User List</div>,
            detail: () => <div>User Detail</div>,
          },
        },
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers).toBeDefined();
    });

    it('should map mixed flat and nested handlers', () => {
      const router = createRSCRouter();
      const routes = route({
        home: '/',
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
      });

      router.route(routes).map({
        home: () => <div>Home</div>,
        blog: {
          index: () => <div>Blog Index</div>,
          post: () => <div>Blog Post</div>,
        },
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers?.home).toBeDefined();
      expect(registered[0]?.handlers?.blog).toBeDefined();
    });
  });

  describe('Handlers with symbols', () => {
    it('should accept route.layout symbol', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const Layout = () => <div>Layout</div>;

      router.route(routes).map({
        [route.layout]: Layout,
        home: () => <div>Home</div>,
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers?.[route.layout]).toBe(Layout);
    });

    it('should accept route.parallel symbol', () => {
      const router = createRSCRouter();
      const routes = route({ dashboard: '/dashboard' });

      router.route(routes).map({
        [route.parallel]: {
          '@sidebar': () => <div>Sidebar</div>,
        },
        dashboard: () => <div>Dashboard</div>,
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers?.[route.parallel]).toBeDefined();
    });

    it('should accept multiple symbols', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router.route(routes).map({
        [route.layout]: () => <div>Layout</div>,
        [route.loading]: () => <div>Loading</div>,
        [route.error]: () => <div>Error</div>,
        home: () => <div>Home</div>,
      });

      const registered = router.getRegisteredRoutes();
      const handlers = registered[0]?.handlers;

      expect(handlers?.[route.layout]).toBeDefined();
      expect(handlers?.[route.loading]).toBeDefined();
      expect(handlers?.[route.error]).toBeDefined();
    });
  });

  describe('Handler context', () => {
    it('should accept handlers with context parameter', () => {
      const router = createRSCRouter();
      const routes = route({ user: '/users/:id' });

      const handler = (ctx: any) => <div>User {ctx.params.id}</div>;

      router.route(routes).map({
        user: handler,
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers?.user).toBe(handler);
    });

    it('should accept async handlers', () => {
      const router = createRSCRouter();
      const routes = route({ posts: '/posts' });

      const handler = async () => {
        return <div>Posts</div>;
      };

      router.route(routes).map({
        posts: handler,
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers?.posts).toBe(handler);
    });
  });

  describe('Handler variations', () => {
    it('should accept handlers object directly', () => {
      const router = createRSCRouter();
      const routes = route({ home: '/', about: '/about' });

      router.route(routes).map({
        home: () => <div>Home</div>,
        about: () => <div>About</div>,
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers).toBeDefined();
    });

    it('should accept handlers with various return types', () => {
      const router = createRSCRouter();
      const routes = route({ page: '/page', json: '/json' });

      router.route(routes).map({
        page: () => <div>Page</div>,
        json: () => Response.json({ data: 'test' }),
      });

      const registered = router.getRegisteredRoutes();
      expect(registered[0]?.handlers?.page).toBeDefined();
      expect(registered[0]?.handlers?.json).toBeDefined();
    });
  });

  describe('Return value and chaining', () => {
    it('should return router for further route registrations', () => {
      const router = createRSCRouter();
      const routes1 = route({ home: '/' });
      const routes2 = route({ about: '/about' });

      const result = router
        .route(routes1)
        .map({ home: () => <div>Home</div> })
        .route(routes2)
        .map({ about: () => <div>About</div> });

      expect(result).toBe(router);
    });

    it('should allow chaining multiple route registrations', () => {
      const router = createRSCRouter();

      router
        .route(route({ home: '/' }))
        .map({ home: () => <div>Home</div> })
        .route(route({ about: '/about' }))
        .map({ about: () => <div>About</div> })
        .route(route({ contact: '/contact' }))
        .map({ contact: () => <div>Contact</div> });

      const registered = router.getRegisteredRoutes();
      expect(registered).toHaveLength(3);
    });
  });
});
