/**
 * Tests for Linear Pattern Matcher
 * Following TDD: Tests define the Hono-inspired matching algorithm
 */

import { describe, it, expect } from 'vitest';
import { LinearMatcher } from '../linear-matcher';

describe('LinearMatcher - Static and dynamic routes', () => {
  describe('Static route matching', () => {
    it('should match exact static routes', () => {
      const matcher = new LinearMatcher('/about');

      expect(matcher.match('/about')).toEqual({
        matched: true,
        params: {},
      });

      expect(matcher.match('/contact')).toEqual({
        matched: false,
        params: {},
      });
    });

    it('should match root route', () => {
      const matcher = new LinearMatcher('/');

      expect(matcher.match('/')).toEqual({
        matched: true,
        params: {},
      });

      expect(matcher.match('/about')).toEqual({
        matched: false,
        params: {},
      });
    });

    it('should match multi-segment static routes', () => {
      const matcher = new LinearMatcher('/blog/posts/recent');

      expect(matcher.match('/blog/posts/recent')).toEqual({
        matched: true,
        params: {},
      });

      expect(matcher.match('/blog/posts')).toEqual({
        matched: false,
        params: {},
      });
    });

    it('should be case-sensitive', () => {
      const matcher = new LinearMatcher('/About');

      expect(matcher.match('/About')).toEqual({
        matched: true,
        params: {},
      });

      expect(matcher.match('/about')).toEqual({
        matched: false,
        params: {},
      });
    });
  });

  describe('Dynamic segment matching', () => {
    it('should match single dynamic segment', () => {
      const matcher = new LinearMatcher('/users/:id');

      expect(matcher.match('/users/123')).toEqual({
        matched: true,
        params: { id: '123' },
      });

      expect(matcher.match('/users/abc')).toEqual({
        matched: true,
        params: { id: 'abc' },
      });
    });

    it('should not match wrong path structure', () => {
      const matcher = new LinearMatcher('/users/:id');

      expect(matcher.match('/posts/123')).toEqual({
        matched: false,
        params: {},
      });

      expect(matcher.match('/users')).toEqual({
        matched: false,
        params: {},
      });

      expect(matcher.match('/users/123/edit')).toEqual({
        matched: false,
        params: {},
      });
    });

    it('should match multiple dynamic segments', () => {
      const matcher = new LinearMatcher('/blog/:category/:slug');

      expect(matcher.match('/blog/tech/react-hooks')).toEqual({
        matched: true,
        params: {
          category: 'tech',
          slug: 'react-hooks',
        },
      });
    });

    it('should match dynamic segments with dashes and underscores', () => {
      const matcher = new LinearMatcher('/posts/:post_id');

      expect(matcher.match('/posts/my-post-123')).toEqual({
        matched: true,
        params: { post_id: 'my-post-123' },
      });
    });

    it('should not match slashes in dynamic segments', () => {
      const matcher = new LinearMatcher('/users/:id');

      // Dynamic segments should NOT match slashes
      expect(matcher.match('/users/123/profile')).toEqual({
        matched: false,
        params: {},
      });
    });
  });

  describe('Mixed static and dynamic segments', () => {
    it('should match pattern with mixed segments', () => {
      const matcher = new LinearMatcher('/api/users/:id/posts/:postId');

      expect(matcher.match('/api/users/alice/posts/42')).toEqual({
        matched: true,
        params: {
          id: 'alice',
          postId: '42',
        },
      });
    });

    it('should match dynamic segment at start', () => {
      const matcher = new LinearMatcher('/:lang/about');

      expect(matcher.match('/en/about')).toEqual({
        matched: true,
        params: { lang: 'en' },
      });
    });

    it('should match dynamic segment at end', () => {
      const matcher = new LinearMatcher('/posts/:slug');

      expect(matcher.match('/posts/hello-world')).toEqual({
        matched: true,
        params: { slug: 'hello-world' },
      });
    });
  });

  describe('Lazy compilation (JIT)', () => {
    it('should not compile pattern on instantiation', () => {
      // Matcher should be created instantly
      const startTime = performance.now();
      const matcher = new LinearMatcher('/users/:id');
      const createTime = performance.now() - startTime;

      // Should be very fast (< 1ms) - no compilation yet
      expect(createTime).toBeLessThan(5);
      expect(matcher).toBeDefined();
    });

    it('should compile pattern on first match', () => {
      const matcher = new LinearMatcher('/users/:id');

      // First match compiles and caches
      const result1 = matcher.match('/users/123');
      expect(result1.matched).toBe(true);

      // Second match uses cached compilation
      const result2 = matcher.match('/users/456');
      expect(result2.matched).toBe(true);
      expect(result2.params.id).toBe('456');
    });

    it('should cache compiled pattern', () => {
      const matcher = new LinearMatcher('/blog/:category/:slug');

      // Compile on first call
      matcher.match('/blog/tech/article');

      // Subsequent calls should be fast (using cache)
      const startTime = performance.now();
      for (let i = 0; i < 1000; i++) {
        matcher.match('/blog/tech/article-' + i);
      }
      const duration = performance.now() - startTime;

      // Should be fast with cached regex
      expect(duration).toBeLessThan(100); // 100ms for 1000 matches
    });
  });

  describe('Special characters in paths', () => {
    it('should handle paths with dashes', () => {
      const matcher = new LinearMatcher('/user-profile');

      expect(matcher.match('/user-profile')).toEqual({
        matched: true,
        params: {},
      });
    });

    it('should handle paths with underscores', () => {
      const matcher = new LinearMatcher('/api_v1/users');

      expect(matcher.match('/api_v1/users')).toEqual({
        matched: true,
        params: {},
      });
    });

    it('should handle paths with numbers', () => {
      const matcher = new LinearMatcher('/api/v1');

      expect(matcher.match('/api/v1')).toEqual({
        matched: true,
        params: {},
      });
    });

    it('should handle file extensions', () => {
      const matcher = new LinearMatcher('/sitemap.xml');

      expect(matcher.match('/sitemap.xml')).toEqual({
        matched: true,
        params: {},
      });
    });

    it('should handle dynamic segments with extensions', () => {
      const matcher = new LinearMatcher('/users/:id.json');

      expect(matcher.match('/users/123.json')).toEqual({
        matched: true,
        params: { id: '123' },
      });

      expect(matcher.match('/users/123')).toEqual({
        matched: false,
        params: {},
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle trailing slashes in pattern', () => {
      const matcher = new LinearMatcher('/about/');

      expect(matcher.match('/about/')).toEqual({
        matched: true,
        params: {},
      });

      // Depending on implementation, may or may not match without trailing slash
      // For now, require exact match
    });

    it('should handle empty segments gracefully', () => {
      const matcher = new LinearMatcher('/a//b');

      // Should match exact path (even with double slash)
      expect(matcher.match('/a//b')).toEqual({
        matched: true,
        params: {},
      });
    });

    it('should handle very long paths', () => {
      const matcher = new LinearMatcher(
        '/a/b/c/d/e/f/g/h/i/j/:id/l/m/n/o/p'
      );

      expect(matcher.match('/a/b/c/d/e/f/g/h/i/j/123/l/m/n/o/p')).toEqual({
        matched: true,
        params: { id: '123' },
      });
    });
  });

  describe('Match result structure', () => {
    it('should return matched: false for non-matches', () => {
      const matcher = new LinearMatcher('/users/:id');

      const result = matcher.match('/posts/123');

      expect(result).toHaveProperty('matched', false);
      expect(result).toHaveProperty('params');
      expect(result.params).toEqual({});
    });

    it('should return matched: true with params for matches', () => {
      const matcher = new LinearMatcher('/users/:id');

      const result = matcher.match('/users/alice');

      expect(result).toHaveProperty('matched', true);
      expect(result).toHaveProperty('params');
      expect(result.params).toHaveProperty('id', 'alice');
    });

    it('should preserve param order', () => {
      const matcher = new LinearMatcher('/:a/:b/:c');

      const result = matcher.match('/1/2/3');

      expect(result.params).toEqual({ a: '1', b: '2', c: '3' });
    });
  });
});
