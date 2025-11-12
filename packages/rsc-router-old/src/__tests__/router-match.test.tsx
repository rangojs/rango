/**
 * Tests for router.match() - Request matching and middleware execution
 * Following TDD: Tests define the complete matching and execution flow
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('router.match() - Request matching', () => {
  describe('Basic route matching', () => {
    it('should match static routes', async () => {
      const router = createRSCRouter();
      const routes = route({ about: '/about' });

      router.route(routes).map({
        about: () => <div>About</div>,
      });

      const request = new Request('http://localhost/about');
      const result = await router.match(request);

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('should return null for non-matching routes', async () => {
      const router = createRSCRouter();
      const routes = route({ about: '/about' });

      router.route(routes).map({
        about: () => <div>About</div>,
      });

      const request = new Request('http://localhost/contact');
      const result = await router.match(request);

      expect(result).toBeNull();
    });

    it('should match dynamic routes', async () => {
      const router = createRSCRouter();
      const routes = route({ user: '/users/:id' });

      router.route(routes).map({
        user: (ctx) => <div>User {ctx.params.id}</div>,
      });

      const request = new Request('http://localhost/users/123');
      const result = await router.match(request);

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });
  });

  describe('Route with prefix', () => {
    it('should match routes mounted with prefix', async () => {
      const router = createRSCRouter();
      const routes = route({ index: '/', show: '/:id' });

      router.route('/blog', routes).map({
        index: () => <div>Blog Index</div>,
        show: (ctx) => <div>Post {ctx.params.id}</div>,
      });

      const request = new Request('http://localhost/blog/');
      const result = await router.match(request);

      expect(result).not.toBeNull();
    });

    it('should compose prefix with route path', async () => {
      const router = createRSCRouter();
      const routes = route({ show: '/:slug' });

      router.route('/blog', routes).map({
        show: (ctx) => <div>Post {ctx.params.slug}</div>,
      });

      const request = new Request('http://localhost/blog/hello-world');
      const result = await router.match(request);

      expect(result).not.toBeNull();
    });
  });

  describe('Middleware execution', () => {
    it('should execute global middleware', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const middlewareCalls: string[] = [];

      router.use(async (ctx, next) => {
        middlewareCalls.push('global');
        await next();
      });

      router.route(routes).map({
        home: () => <div>Home</div>,
      });

      const request = new Request('http://localhost/');
      await router.match(request);

      expect(middlewareCalls).toContain('global');
    });

    it('should execute route-specific middleware', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const middlewareCalls: string[] = [];

      router.route(routes).use(async (ctx, next) => {
        middlewareCalls.push('route-specific');
        await next();
      }).map({
        home: () => <div>Home</div>,
      });

      const request = new Request('http://localhost/');
      await router.match(request);

      expect(middlewareCalls).toContain('route-specific');
    });

    it('should execute middleware in correct order', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const order: number[] = [];

      router.use(async (ctx, next) => {
        order.push(1);
        await next();
        order.push(4);
      });

      router.use(async (ctx, next) => {
        order.push(2);
        await next();
        order.push(3);
      });

      router.route(routes).map({
        home: () => <div>Home</div>,
      });

      const request = new Request('http://localhost/');
      await router.match(request);

      // Should execute in order: 1, 2, handler, 3, 4
      expect(order).toEqual([1, 2, 3, 4]);
    });

    it('should execute global before route-specific middleware', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const order: string[] = [];

      router.use(async (ctx, next) => {
        order.push('global');
        await next();
      });

      router.route(routes).use(async (ctx, next) => {
        order.push('route');
        await next();
      }).map({
        home: () => <div>Home</div>,
      });

      const request = new Request('http://localhost/');
      await router.match(request);

      expect(order).toEqual(['global', 'route']);
    });

    it('should stop execution if middleware does not call next', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const calls: string[] = [];

      router.use(async () => {
        calls.push('mw1');
        // No next() call - should stop here
      });

      router.use(async (ctx, next) => {
        calls.push('mw2');
        await next();
      });

      router.route(routes).map({
        home: () => {
          calls.push('handler');
          return <div>Home</div>;
        },
      });

      const request = new Request('http://localhost/');
      await router.match(request);

      expect(calls).toEqual(['mw1']);
      expect(calls).not.toContain('mw2');
      expect(calls).not.toContain('handler');
    });
  });

  describe('Params extraction', () => {
    it('should provide params in middleware context', async () => {
      const router = createRSCRouter();
      const routes = route({ user: '/users/:id' });
      let capturedParams: any;

      router.use(async (ctx, next) => {
        capturedParams = ctx.params;
        await next();
      });

      router.route(routes).map({
        user: () => <div>User</div>,
      });

      const request = new Request('http://localhost/users/alice');
      await router.match(request);

      expect(capturedParams).toEqual({ id: 'alice' });
    });

    it('should provide multiple params', async () => {
      const router = createRSCRouter();
      const routes = route({ post: '/blog/:category/:slug' });
      let capturedParams: any;

      router.route(routes).use(async (ctx, next) => {
        capturedParams = ctx.params;
        await next();
      }).map({
        post: () => <div>Post</div>,
      });

      const request = new Request('http://localhost/blog/tech/react-hooks');
      await router.match(request);

      expect(capturedParams).toEqual({
        category: 'tech',
        slug: 'react-hooks',
      });
    });
  });

  describe('First match wins (linear scanning)', () => {
    it('should match first registered route', async () => {
      const router = createRSCRouter();
      const routes1 = route({ home: '/' });
      const routes2 = route({ index: '/' });

      router.route(routes1).map({
        home: () => <div>First</div>,
      });

      router.route(routes2).map({
        index: () => <div>Second</div>,
      });

      const request = new Request('http://localhost/');
      const result = await router.match(request);

      // Should match routes1 (registered first)
      expect(result).not.toBeNull();
    });
  });

  describe('Context object', () => {
    it('should provide complete context to middleware', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      let capturedContext: any;

      router.use(async (ctx, next) => {
        capturedContext = ctx;
        await next();
      });

      router.route(routes).map({
        home: () => <div>Home</div>,
      });

      const request = new Request('http://localhost/?foo=bar');
      await router.match(request);

      expect(capturedContext).toHaveProperty('request');
      expect(capturedContext).toHaveProperty('pathname', '/');
      expect(capturedContext).toHaveProperty('url');
      expect(capturedContext).toHaveProperty('params');
      expect(capturedContext).toHaveProperty('meta');
      expect(capturedContext.url.searchParams.get('foo')).toBe('bar');
    });
  });
});
