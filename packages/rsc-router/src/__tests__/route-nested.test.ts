/**
 * Tests for route() function - Nested route support
 * Following TDD: These tests define the expected nested route API
 */

import { describe, it, expect } from 'vitest';
import { route } from '../route-definition';

describe('route() function - Nested route support', () => {
  describe('Simple nested routes', () => {
    it('should handle single-level nested routes', () => {
      const routes = route({
        blog: {
          index: '/blog',
          show: '/blog/:slug',
        },
      });

      expect(routes.blog).toBeDefined();
      expect(routes.blog.index).toBe('/blog');
      expect(routes.blog.show).toBe('/blog/:slug');
    });

    it('should handle multiple nested groups', () => {
      const routes = route({
        blog: {
          index: '/blog',
          show: '/blog/:slug',
        },
        admin: {
          dashboard: '/admin',
          users: '/admin/users',
        },
      });

      expect(routes.blog.index).toBe('/blog');
      expect(routes.blog.show).toBe('/blog/:slug');
      expect(routes.admin.dashboard).toBe('/admin');
      expect(routes.admin.users).toBe('/admin/users');
    });

    it('should handle nested routes with dynamic segments', () => {
      const routes = route({
        users: {
          list: '/users',
          detail: '/users/:id',
          posts: '/users/:id/posts',
        },
      });

      expect(routes.users.list).toBe('/users');
      expect(routes.users.detail).toBe('/users/:id');
      expect(routes.users.posts).toBe('/users/:id/posts');
    });
  });

  describe('Deep nesting', () => {
    it('should handle two levels of nesting', () => {
      const routes = route({
        shop: {
          products: {
            list: '/shop/products',
            detail: '/shop/products/:id',
          },
          cart: '/shop/cart',
        },
      });

      expect(routes.shop.products.list).toBe('/shop/products');
      expect(routes.shop.products.detail).toBe('/shop/products/:id');
      expect(routes.shop.cart).toBe('/shop/cart');
    });

    it('should handle three levels of nesting', () => {
      const routes = route({
        api: {
          v1: {
            users: {
              list: '/api/v1/users',
              detail: '/api/v1/users/:id',
            },
          },
        },
      });

      expect(routes.api.v1.users.list).toBe('/api/v1/users');
      expect(routes.api.v1.users.detail).toBe('/api/v1/users/:id');
    });

    it('should handle mixed nesting depths', () => {
      const routes = route({
        home: '/',
        blog: {
          index: '/blog',
          post: '/blog/:slug',
        },
        admin: {
          users: {
            list: '/admin/users',
            detail: '/admin/users/:id',
          },
          settings: '/admin/settings',
        },
      });

      expect(routes.home).toBe('/');
      expect(routes.blog.index).toBe('/blog');
      expect(routes.blog.post).toBe('/blog/:slug');
      expect(routes.admin.users.list).toBe('/admin/users');
      expect(routes.admin.users.detail).toBe('/admin/users/:id');
      expect(routes.admin.settings).toBe('/admin/settings');
    });
  });

  describe('Nested route utilities', () => {
    it('should provide getRouteNames for nested groups', () => {
      const routes = route({
        blog: {
          index: '/blog',
          show: '/blog/:slug',
        },
      });

      // Top-level names
      expect(routes.getRouteNames()).toContain('blog');

      // Nested group should also have getRouteNames
      expect(routes.blog.getRouteNames()).toEqual(['index', 'show']);
    });

    it('should support has() method on nested groups', () => {
      const routes = route({
        admin: {
          dashboard: '/admin',
          users: '/admin/users',
        },
      });

      expect(routes.has('admin')).toBe(true);
      expect(routes.admin.has('dashboard')).toBe(true);
      expect(routes.admin.has('users')).toBe(true);
      expect(routes.admin.has('invalid')).toBe(false);
    });

    it('should support get() method on nested groups', () => {
      const routes = route({
        api: {
          users: '/api/users',
          posts: '/api/posts',
        },
      });

      expect(routes.get('api')).toBeDefined();
      expect(routes.api.get('users')).toBe('/api/users');
      expect(routes.api.get('posts')).toBe('/api/posts');
    });
  });

  describe('Type safety with nested routes', () => {
    it('should provide autocomplete for nested route names', () => {
      const routes = route({
        blog: {
          index: '/blog',
          show: '/blog/:slug',
        },
      });

      // TypeScript should know these exist
      const blogIndex: string = routes.blog.index;
      const blogShow: string = routes.blog.show;

      expect(blogIndex).toBe('/blog');
      expect(blogShow).toBe('/blog/:slug');
    });

    it('should prevent access to invalid nested routes', () => {
      const routes = route({
        users: {
          list: '/users',
        },
      });

      // TypeScript should allow valid access
      expect(routes.users.list).toBe('/users');

      // This would be a TypeScript error:
      // routes.users.invalid // ❌ Compile error
    });
  });

  describe('Nested routes with all pattern types', () => {
    it('should support optional segments in nested routes', () => {
      const routes = route({
        shop: {
          products: '/shop/products/:category?',
          detail: '/shop/:id?/details',
        },
      });

      expect(routes.shop.products).toBe('/shop/products/:category?');
      expect(routes.shop.detail).toBe('/shop/:id?/details');
    });

    it('should support file extensions in nested routes', () => {
      const routes = route({
        api: {
          users: '/api/users.json',
          userDetail: '/api/users/:id.json',
        },
      });

      expect(routes.api.users).toBe('/api/users.json');
      expect(routes.api.userDetail).toBe('/api/users/:id.json');
    });

    it('should support wildcards in nested routes', () => {
      const routes = route({
        files: {
          all: '/files/*',
          images: '/files/images/*',
        },
      });

      expect(routes.files.all).toBe('/files/*');
      expect(routes.files.images).toBe('/files/images/*');
    });
  });
});
