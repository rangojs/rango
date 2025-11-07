import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ExtractRouteParams,
  RouteContext,
  RouteMap,
  HandlerMap,
  TypedRoute,
} from './types';

describe('Router Type System', () => {
  describe('ExtractRouteParams', () => {
    it('should extract single parameter', () => {
      type Params = ExtractRouteParams<'/posts/:id'>;
      expectTypeOf<Params>().toEqualTypeOf<{ id: string }>();
    });

    it('should extract multiple parameters', () => {
      type Params = ExtractRouteParams<'/users/:userId/posts/:postId'>;
      expectTypeOf<Params>().toEqualTypeOf<{
        userId: string;
        postId: string;
      }>();
    });

    it('should handle routes without parameters', () => {
      type Params = ExtractRouteParams<'/about'>;
      expectTypeOf<Params>().toEqualTypeOf<{}>();
    });

    it('should handle complex nested paths', () => {
      type Params = ExtractRouteParams<'/api/v1/:version/users/:id/settings'>;
      expectTypeOf<Params>().toEqualTypeOf<{
        version: string;
        id: string;
      }>();
    });
  });

  describe('RouteContext', () => {
    it('should have correct shape', () => {
      const context: RouteContext = {
        params: { id: '123' },
        searchParams: new URLSearchParams('q=test'),
        pathname: '/posts/123',
        url: new URL('http://localhost/posts/123?q=test'),
        request: new Request('http://localhost/posts/123'),
        meta: {},
      };

      expect(context.params.id).toBe('123');
      expect(context.searchParams.get('q')).toBe('test');
      expect(context.pathname).toBe('/posts/123');
    });

    it('should support typed params', () => {
      type PostContext = RouteContext<{ id: string; slug: string }>;

      const context: PostContext = {
        params: { id: '123', slug: 'my-post' },
        searchParams: new URLSearchParams(),
        pathname: '/posts/123/my-post',
        url: new URL('http://localhost/posts/123/my-post'),
        request: new Request('http://localhost/posts/123/my-post'),
        meta: {},
      };

      // TypeScript should know these exist
      expect(context.params.id).toBe('123');
      expect(context.params.slug).toBe('my-post');
    });
  });

  describe('RouteMap', () => {
    it('should support flat route structures', () => {
      const routes: RouteMap = {
        home: '/',
        about: '/about',
        contact: '/contact',
      };

      expect(routes.home).toBe('/');
      expect(routes.about).toBe('/about');
    });

    it('should support nested route structures', () => {
      const routes: RouteMap = {
        home: '/',
        blog: {
          index: '/',
          post: '/:slug',
          archive: '/archive',
        },
        admin: {
          dashboard: '/',
          users: '/users',
          settings: {
            general: '/general',
            security: '/security',
          },
        },
      };

      expect(routes.home).toBe('/');
      expect(typeof routes.blog).toBe('object');
      expect(typeof routes.admin).toBe('object');
    });

    it('should support route definitions with methods', () => {
      const routes: RouteMap = {
        api: {
          users: {
            pattern: '/api/users',
            method: 'GET',
          },
          createUser: {
            pattern: '/api/users',
            method: 'POST',
          },
        },
      };

      expect((routes.api as RouteMap).users).toMatchObject({
        pattern: '/api/users',
        method: 'GET',
      });
    });
  });

  describe('HandlerMap', () => {
    it('should mirror route structure', () => {
      // Define routes
      type Routes = {
        home: string;
        blog: {
          index: string;
          post: string;
        };
      };

      // Handler map should have same structure
      type Handlers = HandlerMap<Routes>;

      // This should compile
      const handlers: Partial<Handlers> = {
        home: async () => null,
        blog: {
          index: async () => null,
          post: async () => null,
        },
      };

      expect(handlers).toBeDefined();
    });
  });

  describe('TypedRoute', () => {
    it('should represent a typed route', () => {
      type PostRoute = TypedRoute<'/posts/:id', 'GET'>;

      const route: PostRoute = {
        pattern: '/posts/:id',
        method: 'GET',
        params: { id: 'string' as any }, // Type system knows about 'id'
      };

      expect(route.pattern).toBe('/posts/:id');
      expect(route.method).toBe('GET');
    });
  });

  describe('Symbol Keys', () => {
    it('should have correct symbol keys', async () => {
      // Import the symbols at the top of the file
      const { RouteSymbols } = await import('./types');

      expect(typeof RouteSymbols.middleware).toBe('symbol');
      expect(typeof RouteSymbols.layout).toBe('symbol');
      expect(typeof RouteSymbols.revalidate).toBe('symbol');
      expect(typeof RouteSymbols.loading).toBe('symbol');
      expect(typeof RouteSymbols.error).toBe('symbol');
    });
  });
});