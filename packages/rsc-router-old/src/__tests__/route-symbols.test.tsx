/**
 * Tests for route symbols - Special keys for route metadata
 * Following TDD: These tests define the expected symbol API
 */

import { describe, it, expect } from 'vitest';
import { route } from '../route-definition';

describe('route symbols - Special metadata keys', () => {
  describe('Symbol existence and uniqueness', () => {
    it('should export route.layout symbol', () => {
      expect(route.layout).toBeDefined();
      expect(typeof route.layout).toBe('symbol');
    });

    it('should export route.parallel symbol', () => {
      expect(route.parallel).toBeDefined();
      expect(typeof route.parallel).toBe('symbol');
    });

    it('should export route.loading symbol', () => {
      expect(route.loading).toBeDefined();
      expect(typeof route.loading).toBe('symbol');
    });

    it('should export route.error symbol', () => {
      expect(route.error).toBeDefined();
      expect(typeof route.error).toBe('symbol');
    });

    it('should export route.revalidate symbol', () => {
      expect(route.revalidate).toBeDefined();
      expect(typeof route.revalidate).toBe('symbol');
    });

    it('should have unique symbols', () => {
      const symbols = [
        route.layout,
        route.parallel,
        route.loading,
        route.error,
        route.revalidate,
      ];

      // All symbols should be unique
      const uniqueSymbols = new Set(symbols);
      expect(uniqueSymbols.size).toBe(symbols.length);
    });
  });

  describe('Symbol usage in route handlers', () => {
    it('should allow using route.layout as object key', () => {
      const DummyLayout = () => null;

      const handler = {
        [route.layout]: DummyLayout,
        index: () => <div>Content</div>,
      };

      expect(handler[route.layout]).toBe(DummyLayout);
    });

    it('should allow using route.parallel as object key', () => {
      const Sidebar = () => null;
      const Modal = () => null;

      const handler = {
        [route.parallel]: {
          '@sidebar': Sidebar,
          '@modal': Modal,
        },
        index: () => <div>Content</div>,
      };

      expect(handler[route.parallel]).toEqual({
        '@sidebar': Sidebar,
        '@modal': Modal,
      });
    });

    it('should allow using route.loading as object key', () => {
      const LoadingComponent = () => <div>Loading...</div>;

      const handler = {
        [route.loading]: LoadingComponent,
        index: () => <div>Content</div>,
      };

      expect(handler[route.loading]).toBe(LoadingComponent);
    });

    it('should allow using route.error as object key', () => {
      const ErrorComponent = () => <div>Error</div>;

      const handler = {
        [route.error]: ErrorComponent,
        index: () => <div>Content</div>,
      };

      expect(handler[route.error]).toBe(ErrorComponent);
    });

    it('should allow using route.revalidate as object key', () => {
      const revalidateFn = () => true;

      const handler = {
        [route.revalidate]: revalidateFn,
        index: () => <div>Content</div>,
      };

      expect(handler[route.revalidate]).toBe(revalidateFn);
    });
  });

  describe('Symbol descriptions', () => {
    it('should have descriptive symbol names', () => {
      expect(route.layout.description).toBe('route.layout');
      expect(route.parallel.description).toBe('route.parallel');
      expect(route.loading.description).toBe('route.loading');
      expect(route.error.description).toBe('route.error');
      expect(route.revalidate.description).toBe('route.revalidate');
    });
  });

  describe('Multiple symbols in same handler object', () => {
    it('should allow multiple symbols together', () => {
      const Layout = () => null;
      const Loading = () => null;
      const Error = () => null;

      const handler = {
        [route.layout]: Layout,
        [route.loading]: Loading,
        [route.error]: Error,
        [route.parallel]: {
          '@sidebar': () => null,
        },
        index: () => <div>Content</div>,
      };

      expect(handler[route.layout]).toBe(Layout);
      expect(handler[route.loading]).toBe(Loading);
      expect(handler[route.error]).toBe(Error);
      expect(handler[route.parallel]).toBeDefined();
    });
  });

  describe('Nested route handlers with symbols', () => {
    it('should allow symbols in nested route handlers', () => {
      const BlogLayout = () => null;

      const handler = {
        blog: {
          [route.layout]: BlogLayout,
          index: () => <div>Blog Index</div>,
          post: () => <div>Blog Post</div>,
        },
      };

      // Symbol should be accessible in nested handler
      expect(handler.blog[route.layout]).toBe(BlogLayout);
    });

    it('should allow different symbols at different nesting levels', () => {
      const RootLayout = () => null;
      const BlogLayout = () => null;
      const AdminLayout = () => null;

      const handler = {
        [route.layout]: RootLayout,
        blog: {
          [route.layout]: BlogLayout,
          index: () => <div>Blog</div>,
        },
        admin: {
          [route.layout]: AdminLayout,
          dashboard: () => <div>Dashboard</div>,
        },
      };

      expect(handler[route.layout]).toBe(RootLayout);
      expect(handler.blog[route.layout]).toBe(BlogLayout);
      expect(handler.admin[route.layout]).toBe(AdminLayout);
    });
  });
});
