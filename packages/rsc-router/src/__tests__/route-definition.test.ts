/**
 * Tests for route() function - Basic route map creation
 * Following TDD: These tests define the expected API
 */

import { describe, it, expect } from 'vitest';
import { route } from '../route-definition';

describe('route() function - Basic types and simple routes', () => {
  describe('Simple route definitions', () => {
    it('should create a simple route map with string paths', () => {
      const routes = route({
        home: '/',
        about: '/about',
        contact: '/contact',
      });

      expect(routes).toBeDefined();
      expect(routes.home).toBe('/');
      expect(routes.about).toBe('/about');
      expect(routes.contact).toBe('/contact');
    });

    it('should handle dynamic route segments', () => {
      const routes = route({
        user: '/users/:id',
        post: '/posts/:slug',
      });

      expect(routes.user).toBe('/users/:id');
      expect(routes.post).toBe('/posts/:slug');
    });

    it('should handle multiple dynamic segments', () => {
      const routes = route({
        article: '/blog/:category/:slug',
        file: '/files/:folder/:subfolder/:filename',
      });

      expect(routes.article).toBe('/blog/:category/:slug');
      expect(routes.file).toBe('/files/:folder/:subfolder/:filename');
    });

    it('should handle routes with trailing slashes', () => {
      const routes = route({
        dashboard: '/dashboard/',
        settings: '/settings/',
      });

      expect(routes.dashboard).toBe('/dashboard/');
      expect(routes.settings).toBe('/settings/');
    });
  });

  describe('Type safety', () => {
    it('should preserve route names as keys', () => {
      const routes = route({
        home: '/',
        about: '/about',
      });

      // TypeScript should know these keys exist
      const homeRoute: string = routes.home;
      const aboutRoute: string = routes.about;

      expect(homeRoute).toBe('/');
      expect(aboutRoute).toBe('/about');
    });

    it('should return a RouteMap instance with route definitions', () => {
      const input = {
        home: '/',
        about: '/about',
        contact: '/contact',
      };

      const routes = route(input);

      // Should be a RouteMap instance
      expect(routes).toBeInstanceOf(Object);
      // All routes should be accessible as properties
      expect(routes.home).toBe('/');
      expect(routes.about).toBe('/about');
      expect(routes.contact).toBe('/contact');
    });
  });

  describe('Empty and edge cases', () => {
    it('should handle empty route map', () => {
      const routes = route({});

      expect(routes.getRouteNames()).toEqual([]);
      expect(routes.getAll()).toEqual({});
    });

    it('should handle single route', () => {
      const routes = route({
        home: '/',
      });

      expect(routes.home).toBe('/');
      expect(routes.getRouteNames()).toEqual(['home']);
    });

    it('should handle route with query parameters in pattern', () => {
      const routes = route({
        search: '/search?q=:query',
      });

      expect(routes.search).toBe('/search?q=:query');
    });

    it('should handle route with hash in pattern', () => {
      const routes = route({
        docs: '/docs#section',
      });

      expect(routes.docs).toBe('/docs#section');
    });
  });

  describe('Special characters and patterns', () => {
    it('should handle wildcard routes', () => {
      const routes = route({
        catchAll: '/files/*',
        notFound: '*',
      });

      expect(routes.catchAll).toBe('/files/*');
      expect(routes.notFound).toBe('*');
    });

    it('should handle routes with dashes and underscores', () => {
      const routes = route({
        userProfile: '/user-profile',
        apiEndpoint: '/api_v1/users',
      });

      expect(routes.userProfile).toBe('/user-profile');
      expect(routes.apiEndpoint).toBe('/api_v1/users');
    });

    it('should handle routes with numbers', () => {
      const routes = route({
        api: '/api/v1',
        legacy: '/v2/users',
      });

      expect(routes.api).toBe('/api/v1');
      expect(routes.legacy).toBe('/v2/users');
    });
  });
});
