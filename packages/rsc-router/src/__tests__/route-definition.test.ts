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

    // Note: Query parameters and hash fragments are NOT supported in route patterns
    // - Query params should be handled via searchParams, not route matching
    // - Hash fragments are client-side only and never sent to server
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

  describe('Optional path segments', () => {
    it('should handle optional dynamic segments', () => {
      const routes = route({
        user: '/users/:id?',
        blogCategory: '/blog/:category?',
      });

      expect(routes.user).toBe('/users/:id?');
      expect(routes.blogCategory).toBe('/blog/:category?');
    });

    it('should handle optional segments in middle of path', () => {
      const routes = route({
        userEdit: '/users/:id?/edit',
        blogPost: '/blog/:category?/:slug',
      });

      expect(routes.userEdit).toBe('/users/:id?/edit');
      expect(routes.blogPost).toBe('/blog/:category?/:slug');
    });

    it('should handle multiple optional segments', () => {
      const routes = route({
        complex: '/path/:optional1?/:optional2?/:required',
        files: '/files/:year?/:month?/:day?',
      });

      expect(routes.complex).toBe('/path/:optional1?/:optional2?/:required');
      expect(routes.files).toBe('/files/:year?/:month?/:day?');
    });
  });

  describe('File extensions and literals', () => {
    it('should handle routes with file extensions', () => {
      const routes = route({
        aboutHtml: '/about.html',
        apiJson: '/api/users.json',
        feedXml: '/feed.xml',
      });

      expect(routes.aboutHtml).toBe('/about.html');
      expect(routes.apiJson).toBe('/api/users.json');
      expect(routes.feedXml).toBe('/feed.xml');
    });

    it('should handle dynamic segments with file extensions', () => {
      const routes = route({
        userJson: '/users/:id.json',
        postHtml: '/blog/:slug.html',
        fileDownload: '/downloads/:filename.:ext',
      });

      expect(routes.userJson).toBe('/users/:id.json');
      expect(routes.postHtml).toBe('/blog/:slug.html');
      expect(routes.fileDownload).toBe('/downloads/:filename.:ext');
    });

    it('should handle mixed patterns with extensions', () => {
      const routes = route({
        sitemap: '/sitemap.xml',
        robotsTxt: '/robots.txt',
        manifest: '/manifest.json',
        favicon: '/favicon.ico',
      });

      expect(routes.sitemap).toBe('/sitemap.xml');
      expect(routes.robotsTxt).toBe('/robots.txt');
      expect(routes.manifest).toBe('/manifest.json');
      expect(routes.favicon).toBe('/favicon.ico');
    });

    it('should handle optional segments with extensions', () => {
      const routes = route({
        userProfile: '/users/:id?/profile.html',
        apiResource: '/api/:version?/data.json',
      });

      expect(routes.userProfile).toBe('/users/:id?/profile.html');
      expect(routes.apiResource).toBe('/api/:version?/data.json');
    });
  });
});
