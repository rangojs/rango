/**
 * Phase 7.2: _has Parameter Parsing Tests
 *
 * The _has parameter enables client-server differential rendering.
 * During SPA navigation, the client reports which segments it currently has rendered
 * using the _has query parameter (e.g., ?_has=L0,L1,R2).
 *
 * The server parses this parameter to determine what segments need to be sent.
 *
 * Test Coverage:
 * - Parse valid _has parameters
 * - Handle missing _has parameter
 * - Handle empty _has parameter
 * - Handle invalid segment IDs
 * - Handle whitespace in segment IDs
 * - Handle duplicate segment IDs
 * - Return Set for efficient lookup
 */

import { describe, it, expect } from 'vitest';
import { parseClientSegments } from '../segment-system';

describe('Phase 7.2: _has Parameter Parsing', () => {
  describe('parseClientSegments()', () => {
    it('should parse valid _has parameter with single segment', () => {
      const result = parseClientSegments('L0');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(1);
      expect(result.has('L0')).toBe(true);
    });

    it('should parse valid _has parameter with multiple segments', () => {
      const result = parseClientSegments('L0,L1,R2');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });

    it('should parse complex segment list', () => {
      const result = parseClientSegments('L0,L1,R2,L3,R4,P5,P6');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(7);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
      expect(result.has('L3')).toBe(true);
      expect(result.has('R4')).toBe(true);
      expect(result.has('P5')).toBe(true);
      expect(result.has('P6')).toBe(true);
    });

    it('should handle null parameter (initial navigation)', () => {
      const result = parseClientSegments(null);
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it('should handle empty string (initial navigation)', () => {
      const result = parseClientSegments('');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it('should handle whitespace-only string', () => {
      const result = parseClientSegments('   ');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it('should trim whitespace around segment IDs', () => {
      const result = parseClientSegments('L0, L1, R2');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });

    it('should handle whitespace within segment list', () => {
      const result = parseClientSegments('L0 , L1 , R2');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });

    it('should deduplicate segment IDs', () => {
      const result = parseClientSegments('L0,L1,L0,R2,L1');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });

    it('should filter out empty segments from trailing commas', () => {
      const result = parseClientSegments('L0,L1,R2,');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });

    it('should filter out empty segments from leading commas', () => {
      const result = parseClientSegments(',L0,L1,R2');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });

    it('should filter out empty segments from multiple commas', () => {
      const result = parseClientSegments('L0,,L1,,,R2');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });
  });

  describe('parseClientSegments() - Integration with URL', () => {
    it('should parse _has from URL search params', () => {
      const url = new URL('http://localhost/blog/123?_has=L0,L1,R2');
      const hasParam = url.searchParams.get('_has');
      const result = parseClientSegments(hasParam);

      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });

    it('should handle missing _has parameter in URL', () => {
      const url = new URL('http://localhost/blog/123');
      const hasParam = url.searchParams.get('_has');
      const result = parseClientSegments(hasParam);

      expect(result.size).toBe(0);
    });

    it('should handle URL-encoded _has parameter', () => {
      const url = new URL('http://localhost/blog/123?_has=L0%2CL1%2CR2');
      const hasParam = url.searchParams.get('_has');
      const result = parseClientSegments(hasParam);

      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });
  });

  describe('parseClientSegments() - Real-world scenarios', () => {
    it('should parse typical initial navigation (no _has)', () => {
      // Client navigates to /blog/123 for the first time
      const url = new URL('http://localhost/blog/123');
      const hasParam = url.searchParams.get('_has');
      const result = parseClientSegments(hasParam);

      expect(result.size).toBe(0); // No segments yet, full render needed
    });

    it('should parse subsequent navigation (client has segments)', () => {
      // Client has L0,L1,R2 and navigates to /blog/456
      const url = new URL('http://localhost/blog/456?_has=L0,L1,R2');
      const hasParam = url.searchParams.get('_has');
      const result = parseClientSegments(hasParam);

      expect(result.size).toBe(3);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
    });

    it('should parse navigation with parallel routes', () => {
      // Client has layouts, route, and parallel routes
      const url = new URL(
        'http://localhost/dashboard?_has=L0,L1,R2,P3,P4'
      );
      const hasParam = url.searchParams.get('_has');
      const result = parseClientSegments(hasParam);

      expect(result.size).toBe(5);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
      expect(result.has('P3')).toBe(true);
      expect(result.has('P4')).toBe(true);
    });

    it('should parse deep nested route navigation', () => {
      // Client navigating through deep nested routes
      const url = new URL(
        'http://localhost/blog/123/author/456?_has=L0,L1,R2,L3,R4'
      );
      const hasParam = url.searchParams.get('_has');
      const result = parseClientSegments(hasParam);

      expect(result.size).toBe(5);
      expect(result.has('L0')).toBe(true);
      expect(result.has('L1')).toBe(true);
      expect(result.has('R2')).toBe(true);
      expect(result.has('L3')).toBe(true);
      expect(result.has('R4')).toBe(true);
    });
  });

  describe('parseClientSegments() - Edge cases', () => {
    it('should handle very long segment list', () => {
      // Simulate deep nesting with many segments
      const segments = [];
      for (let i = 0; i < 50; i++) {
        const type = i % 3 === 0 ? 'L' : i % 3 === 1 ? 'R' : 'P';
        segments.push(`${type}${i}`);
      }
      const hasParam = segments.join(',');
      const result = parseClientSegments(hasParam);

      expect(result.size).toBe(50);
      expect(result.has('L0')).toBe(true);
      expect(result.has('R49')).toBe(true);
    });

    it('should handle single comma (edge case)', () => {
      const result = parseClientSegments(',');
      expect(result.size).toBe(0);
    });

    it('should handle multiple commas only', () => {
      const result = parseClientSegments(',,,');
      expect(result.size).toBe(0);
    });
  });

  describe('parseClientSegments() - Return type validation', () => {
    it('should always return a Set', () => {
      expect(parseClientSegments(null)).toBeInstanceOf(Set);
      expect(parseClientSegments('')).toBeInstanceOf(Set);
      expect(parseClientSegments('L0')).toBeInstanceOf(Set);
      expect(parseClientSegments('L0,L1,R2')).toBeInstanceOf(Set);
    });

    it('should return Set for efficient has() checks', () => {
      const result = parseClientSegments('L0,L1,R2,L3,R4,P5,P6');

      // Set.has() is O(1) - critical for performance
      const start = performance.now();
      const hasL3 = result.has('L3');
      const hasP6 = result.has('P6');
      const hasL99 = result.has('L99');
      const end = performance.now();

      expect(hasL3).toBe(true);
      expect(hasP6).toBe(true);
      expect(hasL99).toBe(false);
      expect(end - start).toBeLessThan(1); // Should be instant
    });
  });
});
