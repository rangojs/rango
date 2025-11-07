import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RevalidationManager,
  RevalidationStrategies,
  withRevalidation,
} from './revalidation';
import type { RevalidationContext, RouteContext } from './types';

describe('Revalidation System', () => {
  describe('RevalidationManager', () => {
    let manager: RevalidationManager;

    beforeEach(() => {
      manager = new RevalidationManager();
    });

    it('should register route-specific revalidation handlers', async () => {
      const handler = vi.fn(() => true);
      manager.register('blog.post', handler);

      const shouldRevalidate = await manager.shouldRevalidate(
        '/blog/old-post',
        '/blog/new-post',
        'blog.post',
        'blog.post'
      );

      expect(handler).toHaveBeenCalled();
      expect(shouldRevalidate).toBe(true);
    });

    it('should use default handler when no specific handler exists', async () => {
      const defaultHandler = vi.fn(() => false);
      manager.setDefault(defaultHandler);

      const shouldRevalidate = await manager.shouldRevalidate(
        '/about',
        '/contact'
      );

      expect(defaultHandler).toHaveBeenCalled();
      expect(shouldRevalidate).toBe(false);
    });

    it('should default to revalidating when path changes', async () => {
      const shouldRevalidate = await manager.shouldRevalidate(
        '/page1',
        '/page2'
      );

      expect(shouldRevalidate).toBe(true);
    });

    it('should not revalidate when path stays the same (by default)', async () => {
      const shouldRevalidate = await manager.shouldRevalidate(
        '/same',
        '/same'
      );

      expect(shouldRevalidate).toBe(false);
    });

    it('should merge metadata from route configuration', () => {
      const metadata = {
        home: vi.fn(() => true),
        about: vi.fn(() => false),
      };

      manager.mergeFromMetadata(metadata);

      // Handlers should be registered
      expect(manager['revalidationHandlers'].size).toBe(2);
    });
  });

  describe('RevalidationStrategies', () => {
    describe('always', () => {
      it('should always return true', async () => {
        const strategy = RevalidationStrategies.always();
        const ctx: RevalidationContext = {
          currentPath: '/any',
          nextPath: '/path',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx)).toBe(true);
      });
    });

    describe('never', () => {
      it('should always return false', async () => {
        const strategy = RevalidationStrategies.never();
        const ctx: RevalidationContext = {
          currentPath: '/any',
          nextPath: '/different',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx)).toBe(false);
      });
    });

    describe('whenParamsChange', () => {
      it('should revalidate when specified params change', async () => {
        const strategy = RevalidationStrategies.whenParamsChange(['id', 'slug']);

        const ctx1: RevalidationContext = {
          currentPath: '/posts/1',
          nextPath: '/posts/2',
          params: { id: '1' },
          actionParams: { id: '2' },
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx1)).toBe(true);

        const ctx2: RevalidationContext = {
          currentPath: '/posts/1',
          nextPath: '/posts/1',
          params: { id: '1' },
          actionParams: { id: '1' },
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx2)).toBe(false);
      });
    });

    describe('whenPathChanges', () => {
      it('should revalidate when path changes', async () => {
        const strategy = RevalidationStrategies.whenPathChanges();

        const ctx1: RevalidationContext = {
          currentPath: '/page1',
          nextPath: '/page2',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx1)).toBe(true);

        const ctx2: RevalidationContext = {
          currentPath: '/same',
          nextPath: '/same',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx2)).toBe(false);
      });
    });

    describe('whenRouteChanges', () => {
      it('should revalidate when route name changes', async () => {
        const strategy = RevalidationStrategies.whenRouteChanges();

        const ctx1: RevalidationContext = {
          currentPath: '/blog/post1',
          nextPath: '/about',
          currentRouteName: 'blog.post',
          nextRouteName: 'about',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx1)).toBe(true);

        const ctx2: RevalidationContext = {
          currentPath: '/blog/post1',
          nextPath: '/blog/post2',
          currentRouteName: 'blog.post',
          nextRouteName: 'blog.post',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx2)).toBe(false);
      });
    });

    describe('afterInterval', () => {
      it('should revalidate after specified time interval', async () => {
        const strategy = RevalidationStrategies.afterInterval(1000); // 1 second

        const ctx: RevalidationContext = {
          currentPath: '/test',
          nextPath: '/test',
          params: {},
          request: new Request('http://localhost'),
        };

        // First call should revalidate
        expect(await strategy(ctx)).toBe(true);

        // Immediate second call should not revalidate
        expect(await strategy(ctx)).toBe(false);

        // After waiting, should revalidate again
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(await strategy(ctx)).toBe(true);
      });
    });

    describe('any', () => {
      it('should return true if any strategy returns true', async () => {
        const strategy = RevalidationStrategies.any(
          RevalidationStrategies.never(),
          RevalidationStrategies.never(),
          RevalidationStrategies.always()
        );

        const ctx: RevalidationContext = {
          currentPath: '/test',
          nextPath: '/test',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx)).toBe(true);
      });

      it('should return false if all strategies return false', async () => {
        const strategy = RevalidationStrategies.any(
          RevalidationStrategies.never(),
          RevalidationStrategies.never()
        );

        const ctx: RevalidationContext = {
          currentPath: '/test',
          nextPath: '/test',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx)).toBe(false);
      });
    });

    describe('all', () => {
      it('should return true if all strategies return true', async () => {
        const strategy = RevalidationStrategies.all(
          RevalidationStrategies.always(),
          RevalidationStrategies.always()
        );

        const ctx: RevalidationContext = {
          currentPath: '/test',
          nextPath: '/test',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx)).toBe(true);
      });

      it('should return false if any strategy returns false', async () => {
        const strategy = RevalidationStrategies.all(
          RevalidationStrategies.always(),
          RevalidationStrategies.never(),
          RevalidationStrategies.always()
        );

        const ctx: RevalidationContext = {
          currentPath: '/test',
          nextPath: '/test',
          params: {},
          request: new Request('http://localhost'),
        };

        expect(await strategy(ctx)).toBe(false);
      });
    });
  });

  describe('withRevalidation', () => {
    it('should wrap handler with revalidation logic', async () => {
      const handler = vi.fn((ctx: RouteContext) => 'result');
      const revalidationHandler = vi.fn(() => true);

      const wrapped = withRevalidation(handler, revalidationHandler);

      const ctx: RouteContext = {
        params: {},
        searchParams: new URLSearchParams(),
        pathname: '/test',
        url: new URL('http://localhost/test'),
        request: new Request('http://localhost/test'),
        meta: {},
      };

      const result = await wrapped(ctx);

      expect(handler).toHaveBeenCalledWith(ctx);
      expect(result).toBe('result');
      expect(ctx.meta.revalidate).toBe(revalidationHandler);
    });
  });
});