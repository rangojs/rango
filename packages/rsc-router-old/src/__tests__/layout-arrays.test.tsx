/**
 * Tests for Layout Arrays - Multiple nested layouts
 * Following TDD: Tests define how layout arrays create nested wrappers
 */

import { describe, it, expect } from 'vitest';
import { createRSCRouter } from '../create-router';
import { route } from '../route-definition';

describe('Layout Arrays - Nested layouts', () => {
  describe('Basic layout arrays', () => {
    it('should accept array of layouts', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const Layout1 = () => <div>Layout1</div>;
      const Layout2 = () => <div>Layout2</div>;

      router.route(routes).map({
        [route.layout]: [Layout1, Layout2],
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));

      expect((result as any).handlers[route.layout]).toEqual([Layout1, Layout2]);
    });

    it('should maintain layout order (outer to inner)', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const Outer = () => <div>Outer</div>;
      const Middle = () => <div>Middle</div>;
      const Inner = () => <div>Inner</div>;

      router.route(routes).map({
        [route.layout]: [Outer, Middle, Inner],
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));
      const layouts = (result as any).handlers[route.layout];

      expect(layouts).toHaveLength(3);
      expect(layouts[0]).toBe(Outer);
      expect(layouts[1]).toBe(Middle);
      expect(layouts[2]).toBe(Inner);
    });

    it('should support two-level nesting', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const RootLayout = () => <div>Root</div>;
      const AppShell = () => <div>AppShell</div>;

      router.route(routes).map({
        [route.layout]: [RootLayout, AppShell],
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));
      const layouts = (result as any).handlers[route.layout];

      expect(layouts).toEqual([RootLayout, AppShell]);
    });

    it('should support three-level nesting', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const L1 = () => <div>L1</div>;
      const L2 = () => <div>L2</div>;
      const L3 = () => <div>L3</div>;

      router.route(routes).map({
        [route.layout]: [L1, L2, L3],
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));
      const layouts = (result as any).handlers[route.layout];

      expect(layouts).toHaveLength(3);
    });
  });

  describe('Single layout vs array compatibility', () => {
    it('should still support single layout (not array)', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const SingleLayout = () => <div>Layout</div>;

      router.route(routes).map({
        [route.layout]: SingleLayout,  // Not an array
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));

      // Should be stored as-is, not wrapped in array
      expect((result as any).handlers[route.layout]).toBe(SingleLayout);
      expect(Array.isArray((result as any).handlers[route.layout])).toBe(false);
    });

    it('should differentiate between single and array layouts', async () => {
      const router = createRSCRouter();
      const routes1 = route({ page1: '/page1' });
      const routes2 = route({ page2: '/page2' });
      const SingleLayout = () => <div>Single</div>;
      const Layout1 = () => <div>L1</div>;
      const Layout2 = () => <div>L2</div>;

      router.route(routes1).map({
        [route.layout]: SingleLayout,
        page1: () => <div>Page1</div>,
      });

      router.route(routes2).map({
        [route.layout]: [Layout1, Layout2],
        page2: () => <div>Page2</div>,
      });

      const result1 = await router.match(new Request('http://localhost/page1'));
      const result2 = await router.match(new Request('http://localhost/page2'));

      expect(Array.isArray((result1 as any).handlers[route.layout])).toBe(false);
      expect(Array.isArray((result2 as any).handlers[route.layout])).toBe(true);
    });
  });

  describe('Layout arrays with nested routes', () => {
    it('should support layout arrays in nested route handlers', async () => {
      const router = createRSCRouter();
      const routes = route({
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
      });
      const L1 = () => <div>L1</div>;
      const L2 = () => <div>L2</div>;
      const L3 = () => <div>L3</div>;

      router.route(routes).map({
        blog: {
          [route.layout]: [L1, L2, L3],
          index: () => <div>Index</div>,
          post: () => <div>Post</div>,
        },
      });

      const result = await router.match(new Request('http://localhost/blog'));
      expect(result).not.toBeNull();
    });
  });

  describe('Empty layout arrays', () => {
    it('should handle empty layout array', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });

      router.route(routes).map({
        [route.layout]: [],  // Empty array
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));

      expect((result as any).handlers[route.layout]).toEqual([]);
    });
  });

  describe('Layout arrays with middleware', () => {
    it('should execute middleware before layout rendering', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const executionOrder: string[] = [];
      const L1 = () => <div>L1</div>;
      const L2 = () => <div>L2</div>;

      router.use(async (ctx, next) => {
        executionOrder.push('middleware');
        await next();
      });

      router.route(routes).map({
        [route.layout]: [L1, L2],
        home: () => {
          executionOrder.push('handler');
          return <div>Home</div>;
        },
      });

      await router.match(new Request('http://localhost/'));

      expect(executionOrder[0]).toBe('middleware');
    });
  });

  describe('Design doc examples', () => {
    it('should support example from design doc: [RootLayout, AppShell, BlogLayout]', async () => {
      const router = createRSCRouter();
      const routes = route({ home: '/' });
      const RootLayout = () => <div>Root</div>;
      const AppShell = () => <div>AppShell</div>;
      const BlogLayout = () => <div>BlogLayout</div>;

      router.route(routes).map({
        [route.layout]: [RootLayout, AppShell, BlogLayout],
        home: () => <div>Home</div>,
      });

      const result = await router.match(new Request('http://localhost/'));
      const layouts = (result as any).handlers[route.layout];

      expect(layouts).toEqual([RootLayout, AppShell, BlogLayout]);
    });
  });
});
