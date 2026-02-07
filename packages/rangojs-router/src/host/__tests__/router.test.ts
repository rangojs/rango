import { describe, it, expect, vi } from 'vitest';
import { createHostRouter } from '../router';

describe('createHostRouter', () => {
  it('should create a router instance', () => {
    const router = createHostRouter();

    expect(router).toBeDefined();
    expect(router.host).toBeInstanceOf(Function);
    expect(router.use).toBeInstanceOf(Function);
    expect(router.match).toBeInstanceOf(Function);
    expect(router.fallback).toBeInstanceOf(Function);
    expect(router.test).toBeInstanceOf(Function);
  });

  it('should register and match apex domain routes', async () => {
    const router = createHostRouter();
    const handler = vi.fn(() => new Response('apex'));

    router.host(['.']).map(handler);

    const request = new Request('http://example.com/');
    const response = await router.match(request);

    expect(handler).toHaveBeenCalled();
    expect(await response.text()).toBe('apex');
  });

  it('should register and match subdomain routes', async () => {
    const router = createHostRouter();
    const adminHandler = vi.fn(() => new Response('admin'));
    const mainHandler = vi.fn(() => new Response('main'));

    router.host(['admin.*']).map(adminHandler);
    router.host(['.']).map(mainHandler);

    const adminRequest = new Request('http://admin.example.com/');
    const adminResponse = await router.match(adminRequest);

    expect(adminHandler).toHaveBeenCalled();
    expect(await adminResponse.text()).toBe('admin');

    const mainRequest = new Request('http://example.com/');
    const mainResponse = await router.match(mainRequest);

    expect(mainHandler).toHaveBeenCalled();
    expect(await mainResponse.text()).toBe('main');
  });

  it('should match first matching pattern', async () => {
    const router = createHostRouter();
    const handler1 = vi.fn(() => new Response('first'));
    const handler2 = vi.fn(() => new Response('second'));

    router.host(['**']).map(handler1);
    router.host(['.']).map(handler2);

    const request = new Request('http://example.com/');
    const response = await router.match(request);

    expect(handler1).toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
    expect(await response.text()).toBe('first');
  });

  it('should throw NoRouteMatchError for unmatched routes', async () => {
    const router = createHostRouter();
    const { NoRouteMatchError } = await import('../errors');

    router.host(['admin.*']).map(() => new Response('admin'));

    const request = new Request('http://example.com/');

    await expect(router.match(request)).rejects.toThrow(NoRouteMatchError);
  });
});

describe('router.use - Global Middleware', () => {
  it('should execute global middleware', async () => {
    const router = createHostRouter();
    const middleware = vi.fn(async (_req, _ctx, next) => next());

    router.use(middleware);
    router.host(['.']).map(() => new Response('ok'));

    const request = new Request('http://example.com/');
    await router.match(request);

    expect(middleware).toHaveBeenCalled();
  });

  it('should execute multiple global middlewares in order', async () => {
    const router = createHostRouter();
    const order: number[] = [];

    const mw1 = vi.fn(async (_req, _ctx, next) => {
      order.push(1);
      const res = await next();
      order.push(4);
      return res;
    });

    const mw2 = vi.fn(async (_req, _ctx, next) => {
      order.push(2);
      const res = await next();
      order.push(3);
      return res;
    });

    router.use(mw1, mw2);
    router.host(['.']).map(() => new Response('ok'));

    const request = new Request('http://example.com/');
    await router.match(request);

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('should allow middleware to modify context', async () => {
    const router = createHostRouter();

    router.use(async (_req, ctx, next) => {
      ctx.user = { id: 123 };
      return next();
    });

    const handler = vi.fn((_req, ctx) => {
      return new Response(JSON.stringify(ctx.user));
    });

    router.host(['.']).map(handler);

    const request = new Request('http://example.com/');
    const response = await router.match(request);

    expect(JSON.parse(await response.text())).toEqual({ id: 123 });
  });

  it('should allow middleware to short-circuit', async () => {
    const router = createHostRouter();
    const handler = vi.fn(() => new Response('handler'));

    router.use(async () => new Response('blocked', { status: 401 }));
    router.host(['.']).map(handler);

    const request = new Request('http://example.com/');
    const response = await router.match(request);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('blocked');
  });
});

describe('router.host().use - Host-specific Middleware', () => {
  it('should execute host-specific middleware', async () => {
    const router = createHostRouter();
    const middleware = vi.fn(async (_req, _ctx, next) => next());

    router
      .host(['admin.*'])
      .use(middleware)
      .map(() => new Response('ok'));
    router.host(['.']).map(() => new Response('ok'));

    const adminRequest = new Request('http://admin.example.com/');
    await router.match(adminRequest);
    expect(middleware).toHaveBeenCalledTimes(1);

    const mainRequest = new Request('http://example.com/');
    await router.match(mainRequest);
    expect(middleware).toHaveBeenCalledTimes(1); // Should not be called again
  });

  it('should execute global then host-specific middleware', async () => {
    const router = createHostRouter();
    const order: string[] = [];

    router.use(async (_req, _ctx, next) => {
      order.push('global');
      return next();
    });

    router
      .host(['admin.*'])
      .use(async (_req, _ctx, next) => {
        order.push('host');
        return next();
      })
      .map(() => {
        order.push('handler');
        return new Response('ok');
      });

    const request = new Request('http://admin.example.com/');
    await router.match(request);

    expect(order).toEqual(['global', 'host', 'handler']);
  });
});

describe('router.test', () => {
  it('should test if a hostname matches', () => {
    const router = createHostRouter();
    const handler = () => new Response('ok');

    router.host(['admin.*']).map(handler);
    router.host(['.']).map(handler);

    expect(router.test('admin.example.com')).toMatchObject({
      pattern: 'admin.*',
    });

    expect(router.test('example.com')).toMatchObject({
      pattern: '.',
    });

    expect(router.test('unknown.sub.example.com')).toBeNull();
  });
});

describe('router.fallback', () => {
  it('should call fallback handler when cookie override fails', async () => {
    const router = createHostRouter({
      hostOverride: {
        cookieName: 'x-requested-host',
        allowedHosts: ['localhost'],
        validate: (_req, cookieValue) => {
          if (cookieValue === 'invalid') {
            throw new Error('Invalid host');
          }
          return cookieValue;
        },
      },
    });

    const fallbackHandler = vi.fn(() => new Response('fallback'));

    router.fallback().map(fallbackHandler);
    router.host(['.']).map(() => new Response('main'));

    const request = new Request('http://localhost:3000/', {
      headers: {
        cookie: 'x-requested-host=invalid',
      },
    });

    const response = await router.match(request);

    expect(fallbackHandler).toHaveBeenCalled();
    expect(await response.text()).toBe('fallback');
  });

  it('should pass error to fallback handler in context', async () => {
    const { HostValidationError } = await import('../errors');

    const router = createHostRouter({
      hostOverride: {
        cookieName: 'x-requested-host',
        allowedHosts: ['localhost'],
        validate: () => {
          throw new Error('Invalid host');
        },
      },
    });

    const fallbackHandler = vi.fn((_req, ctx) => {
      expect(ctx.error).toBeInstanceOf(HostValidationError);
      expect(ctx.error.message).toBe('Invalid host');
      return new Response('fallback');
    });

    router.fallback().map(fallbackHandler);

    const request = new Request('http://localhost:3000/', {
      headers: {
        cookie: 'x-requested-host=bad.com',
      },
    });

    await router.match(request);

    expect(fallbackHandler).toHaveBeenCalled();
  });
});

describe('Lazy Imports', () => {
  it('should handle lazy imports', async () => {
    const router = createHostRouter();

    router.host(['.']).map(() =>
      Promise.resolve({
        default: () => new Response('lazy loaded'),
      })
    );

    const request = new Request('http://example.com/');
    const response = await router.match(request);

    expect(await response.text()).toBe('lazy loaded');
  });

  it('should handle lazy imports returning routers', async () => {
    const router = createHostRouter();
    const nestedRouter = createHostRouter();

    nestedRouter.host(['**']).map(() => new Response('nested'));

    router.host(['.']).map(() =>
      Promise.resolve({
        default: nestedRouter,
      })
    );

    const request = new Request('http://example.com/');
    const response = await router.match(request);

    expect(await response.text()).toBe('nested');
  });
});
