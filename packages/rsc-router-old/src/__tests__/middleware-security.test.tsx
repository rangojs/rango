/**
 * Tests for Middleware Security - CRITICAL for auth and authorization
 * Following TDD: Tests ensure middleware ALWAYS executes, even on partial renders
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('Middleware Security - Always execute', () => {
  describe('Middleware execution on all requests', () => {
    it('should execute middleware on normal requests', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const authCalls: number[] = [];

      router.use(async (ctx, next) => {
        authCalls.push(1);
        await next();
      });

      router.route(routes).map({
        home: () => <div>Home</div>,
      });

      await router.match(new Request('http://localhost/'));

      expect(authCalls).toHaveLength(1);
    });

    it('should execute middleware on requests with query parameters', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const authCalls: number[] = [];

      router.use(async (ctx, next) => {
        authCalls.push(1);
        await next();
      });

      router.route(routes).map({
        home: () => <div>Home</div>,
      });

      // Request with any query parameter
      await router.match(new Request('http://localhost/?foo=bar'));

      expect(authCalls).toHaveLength(1);
    });

    it('should execute middleware on requests with _has parameter', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const authCalls: number[] = [];

      router.use(async (ctx, next) => {
        authCalls.push(1);
        await next();
      });

      router.route(routes).map({
        home: () => <div>Home</div>,
      });

      // Simulated partial render request with _has parameter
      await router.match(new Request('http://localhost/?_has=L0,L1,R2'));

      expect(authCalls).toHaveLength(1);
    });

    it('should execute middleware on requests with _routes parameter', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const authCalls: number[] = [];

      router.use(async (ctx, next) => {
        authCalls.push(1);
        await next();
      });

      router.route(routes).map({
        home: () => <div>Home</div>,
      });

      // Simulated partial render request with _routes parameter
      await router.match(new Request('http://localhost/?_routes=R3'));

      expect(authCalls).toHaveLength(1);
    });
  });

  describe('Security verification', () => {
    it('should not bypass auth middleware with special query params', async () => {
      const router = createRSCRouter();
      const routes = route({ admin: '/admin' });
      let authChecked = false;

      router.use(async (ctx, next) => {
        authChecked = true;
        // Simulated auth check
        await next();
      });

      router.route(routes).map({
        admin: () => <div>Admin</div>,
      });

      // Try with various query params that might bypass security
      await router.match(new Request('http://localhost/admin?_has=L0'));
      expect(authChecked).toBe(true);

      authChecked = false;
      await router.match(new Request('http://localhost/admin?_routes=R5'));
      expect(authChecked).toBe(true);

      authChecked = false;
      await router.match(new Request('http://localhost/admin?__rsc=true'));
      expect(authChecked).toBe(true);
    });

    it('should execute ALL middleware on partial renders', async () => {
      const router = createRSCRouter();
      const routes = route({ admin: '/admin' });
      const middlewareCalls: string[] = [];

      router
        .use(async (ctx, next) => {
          middlewareCalls.push('global1');
          await next();
        })
        .use(async (ctx, next) => {
          middlewareCalls.push('global2');
          await next();
        });

      router.route(routes)
        .use(async (ctx, next) => {
          middlewareCalls.push('route1');
          await next();
        })
        .use(async (ctx, next) => {
          middlewareCalls.push('route2');
          await next();
        })
        .map({
          admin: () => <div>Admin</div>,
        });

      await router.match(new Request('http://localhost/admin?_has=L0,R1'));

      // ALL middleware must execute
      expect(middlewareCalls).toEqual(['global1', 'global2', 'route1', 'route2']);
    });

    it('should execute middleware before checking _has parameter', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const executionOrder: string[] = [];

      router.use(async (ctx, next) => {
        executionOrder.push('middleware-start');
        // Middleware sees the request first
        const hasParam = ctx.url.searchParams.get('_has');
        if (hasParam) {
          executionOrder.push('saw-_has-param');
        }
        await next();
        executionOrder.push('middleware-end');
      });

      router.route(routes).map({
        home: () => {
          executionOrder.push('handler');
          return <div>Home</div>;
        },
      });

      await router.match(new Request('http://localhost/?_has=L0'));

      // Middleware must execute BEFORE any rendering decision
      expect(executionOrder[0]).toBe('middleware-start');
      expect(executionOrder).toContain('saw-_has-param');
    });
  });

  describe('Route-specific middleware on partial renders', () => {
    it('should execute route-specific middleware on partial renders', async () => {
      const router = createRSCRouter();
      const routes = route({ admin: '/admin' });
      let routeMiddlewareExecuted = false;

      router.route(routes)
        .use(async (ctx, next) => {
          routeMiddlewareExecuted = true;
          await next();
        })
        .map({
          admin: () => <div>Admin</div>,
        });

      await router.match(new Request('http://localhost/admin?_has=L0,R1'));

      expect(routeMiddlewareExecuted).toBe(true);
    });

    it('should execute route middleware even for single segment requests', async () => {
      const router = createRSCRouter();
      const routes = route({ page: '/page' });
      const middlewareCalls: string[] = [];

      router.route(routes)
        .use(async (ctx, next) => {
          middlewareCalls.push('route-auth');
          await next();
        })
        .map({
          page: () => <div>Page</div>,
        });

      // Request for single segment with _routes parameter
      await router.match(new Request('http://localhost/page?_routes=R5'));

      expect(middlewareCalls).toContain('route-auth');
    });
  });

  describe('Documentation verification', () => {
    it('should document that middleware always runs', () => {
      // This test serves as documentation
      // Per design doc: "Middleware MUST execute on EVERY request"
      // This is non-negotiable for security

      expect(true).toBe(true);
    });
  });
});
