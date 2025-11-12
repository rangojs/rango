/**
 * Tests for Linear Matcher - Wildcards and Optional Segments
 * Following TDD: Tests define wildcard and optional segment behavior
 */

import { describe, it, expect } from 'vitest';
import { LinearMatcher } from '../linear-matcher';

describe('LinearMatcher - Wildcards and optional segments', () => {
  describe('Wildcard routes (*)', () => {
    it('should match catch-all wildcard at end', () => {
      const matcher = new LinearMatcher('/files/*');

      expect(matcher.match('/files/a')).toEqual({
        matched: true,
        params: { '*': 'a' },
      });

      expect(matcher.match('/files/a/b/c')).toEqual({
        matched: true,
        params: { '*': 'a/b/c' },
      });
    });

    it('should match root wildcard', () => {
      const matcher = new LinearMatcher('*');

      expect(matcher.match('/anything')).toEqual({
        matched: true,
        params: { '*': '/anything' },
      });

      expect(matcher.match('/nested/path/here')).toEqual({
        matched: true,
        params: { '*': '/nested/path/here' },
      });
    });

    it('should match wildcard after static segments', () => {
      const matcher = new LinearMatcher('/api/v1/*');

      expect(matcher.match('/api/v1/users')).toEqual({
        matched: true,
        params: { '*': 'users' },
      });

      expect(matcher.match('/api/v1/users/123/posts')).toEqual({
        matched: true,
        params: { '*': 'users/123/posts' },
      });
    });

    it('should not match paths before wildcard', () => {
      const matcher = new LinearMatcher('/api/v1/*');

      expect(matcher.match('/api')).toEqual({
        matched: false,
        params: {},
      });

      expect(matcher.match('/api/v2/users')).toEqual({
        matched: false,
        params: {},
      });
    });

    it('should match empty path after wildcard', () => {
      const matcher = new LinearMatcher('/files/*');

      // Depending on implementation, might match /files/ with empty wildcard
      expect(matcher.match('/files/')).toEqual({
        matched: true,
        params: { '*': '' },
      });
    });
  });

  describe('Optional segments (:param?)', () => {
    it('should match with optional segment present', () => {
      const matcher = new LinearMatcher('/users/:id?');

      expect(matcher.match('/users/123')).toEqual({
        matched: true,
        params: { id: '123' },
      });
    });

    it('should match with optional segment absent', () => {
      const matcher = new LinearMatcher('/users/:id?');

      expect(matcher.match('/users')).toEqual({
        matched: true,
        params: {},
      });

      // Or with trailing slash
      expect(matcher.match('/users/')).toEqual({
        matched: true,
        params: {},
      });
    });

    it('should handle optional segment in middle', () => {
      const matcher = new LinearMatcher('/users/:id?/edit');

      // With segment
      expect(matcher.match('/users/123/edit')).toEqual({
        matched: true,
        params: { id: '123' },
      });

      // Without segment
      expect(matcher.match('/users/edit')).toEqual({
        matched: true,
        params: {},
      });
    });

    it('should handle multiple optional segments', () => {
      const matcher = new LinearMatcher('/files/:year?/:month?/:day?');

      // All present
      expect(matcher.match('/files/2025/11/09')).toEqual({
        matched: true,
        params: { year: '2025', month: '11', day: '09' },
      });

      // Partial
      expect(matcher.match('/files/2025/11')).toEqual({
        matched: true,
        params: { year: '2025', month: '11' },
      });

      expect(matcher.match('/files/2025')).toEqual({
        matched: true,
        params: { year: '2025' },
      });

      // None
      expect(matcher.match('/files')).toEqual({
        matched: true,
        params: {},
      });
    });

    it('should handle optional with file extension', () => {
      const matcher = new LinearMatcher('/users/:id?/profile.html');

      expect(matcher.match('/users/123/profile.html')).toEqual({
        matched: true,
        params: { id: '123' },
      });

      expect(matcher.match('/users/profile.html')).toEqual({
        matched: true,
        params: {},
      });
    });
  });

  describe('Named wildcards', () => {
    it('should support named wildcard segments', () => {
      const matcher = new LinearMatcher('/files/:path*');

      expect(matcher.match('/files/a/b/c')).toEqual({
        matched: true,
        params: { path: 'a/b/c' },
      });
    });

    it('should support wildcard after static path', () => {
      const matcher = new LinearMatcher('/docs/:section*');

      expect(matcher.match('/docs/api/reference/hooks')).toEqual({
        matched: true,
        params: { section: 'api/reference/hooks' },
      });
    });
  });

  describe('Complex patterns with wildcards and optional', () => {
    it('should combine static, dynamic, and wildcard', () => {
      const matcher = new LinearMatcher('/api/:version/files/*');

      expect(matcher.match('/api/v1/files/images/logo.png')).toEqual({
        matched: true,
        params: {
          version: 'v1',
          '*': 'images/logo.png',
        },
      });
    });

    it('should combine dynamic, optional, and static', () => {
      const matcher = new LinearMatcher('/blog/:category?/:slug/comments');

      // With optional
      expect(matcher.match('/blog/tech/react-hooks/comments')).toEqual({
        matched: true,
        params: { category: 'tech', slug: 'react-hooks' },
      });

      // Without optional
      expect(matcher.match('/blog/react-hooks/comments')).toEqual({
        matched: true,
        params: { slug: 'react-hooks' },
      });
    });
  });

  describe('Edge cases with wildcards', () => {
    it('should handle wildcard matching slashes', () => {
      const matcher = new LinearMatcher('/files/*');

      // Wildcard should match multiple path segments
      expect(matcher.match('/files/a/b/c/d/e')).toEqual({
        matched: true,
        params: { '*': 'a/b/c/d/e' },
      });
    });

    it('should handle wildcard with special characters', () => {
      const matcher = new LinearMatcher('/static/*');

      expect(matcher.match('/static/images/logo-2024.png')).toEqual({
        matched: true,
        params: { '*': 'images/logo-2024.png' },
      });
    });
  });
});
