/**
 * Tests for Segment ID Generation Functions
 * Following TDD: Tests verify the implementation works
 */

import { describe, it, expect } from 'vitest';
import {
  generateSegmentId,
  parseSegmentId,
  isValidSegmentId,
  createSegment,
} from '../segment-system';

describe('Segment ID Generation Functions', () => {
  describe('generateSegmentId()', () => {
    it('should generate L prefix for layout segments', () => {
      expect(generateSegmentId('layout', 0)).toBe('L0');
      expect(generateSegmentId('layout', 1)).toBe('L1');
      expect(generateSegmentId('layout', 5)).toBe('L5');
    });

    it('should generate R prefix for route segments', () => {
      expect(generateSegmentId('route', 0)).toBe('R0');
      expect(generateSegmentId('route', 2)).toBe('R2');
      expect(generateSegmentId('route', 10)).toBe('R10');
    });

    it('should generate P prefix for parallel segments', () => {
      expect(generateSegmentId('parallel', 0)).toBe('P0');
      expect(generateSegmentId('parallel', 3)).toBe('P3');
      expect(generateSegmentId('parallel', 15)).toBe('P15');
    });

    it('should handle large indices', () => {
      expect(generateSegmentId('layout', 99)).toBe('L99');
      expect(generateSegmentId('route', 100)).toBe('R100');
      expect(generateSegmentId('parallel', 1000)).toBe('P1000');
    });
  });

  describe('parseSegmentId()', () => {
    it('should parse layout segment IDs', () => {
      expect(parseSegmentId('L0')).toEqual({ type: 'layout', index: 0 });
      expect(parseSegmentId('L5')).toEqual({ type: 'layout', index: 5 });
      expect(parseSegmentId('L99')).toEqual({ type: 'layout', index: 99 });
    });

    it('should parse route segment IDs', () => {
      expect(parseSegmentId('R0')).toEqual({ type: 'route', index: 0 });
      expect(parseSegmentId('R2')).toEqual({ type: 'route', index: 2 });
      expect(parseSegmentId('R100')).toEqual({ type: 'route', index: 100 });
    });

    it('should parse parallel segment IDs', () => {
      expect(parseSegmentId('P0')).toEqual({ type: 'parallel', index: 0 });
      expect(parseSegmentId('P3')).toEqual({ type: 'parallel', index: 3 });
      expect(parseSegmentId('P10')).toEqual({ type: 'parallel', index: 10 });
    });

    it('should return null for invalid IDs', () => {
      expect(parseSegmentId('X0')).toBeNull();
      expect(parseSegmentId('L')).toBeNull();
      expect(parseSegmentId('0')).toBeNull();
      expect(parseSegmentId('LL0')).toBeNull();
      expect(parseSegmentId('L0R1')).toBeNull();
    });
  });

  describe('isValidSegmentId()', () => {
    it('should validate correct segment IDs', () => {
      expect(isValidSegmentId('L0')).toBe(true);
      expect(isValidSegmentId('R2')).toBe(true);
      expect(isValidSegmentId('P3')).toBe(true);
      expect(isValidSegmentId('L99')).toBe(true);
    });

    it('should reject invalid segment IDs', () => {
      expect(isValidSegmentId('X0')).toBe(false);
      expect(isValidSegmentId('L')).toBe(false);
      expect(isValidSegmentId('0')).toBe(false);
      expect(isValidSegmentId('LL0')).toBe(false);
      expect(isValidSegmentId('')).toBe(false);
      expect(isValidSegmentId('layout')).toBe(false);
    });
  });

  describe('createSegment()', () => {
    it('should create layout segment', () => {
      const component = <div>Layout</div>;
      const segment = createSegment('layout', 0, component);

      expect(segment.id).toBe('L0');
      expect(segment.type).toBe('layout');
      expect(segment.index).toBe(0);
      expect(segment.component).toBe(component);
    });

    it('should create route segment', () => {
      const component = <div>Content</div>;
      const segment = createSegment('route', 2, component);

      expect(segment.id).toBe('R2');
      expect(segment.type).toBe('route');
      expect(segment.index).toBe(2);
      expect(segment.component).toBe(component);
    });

    it('should create parallel segment with slot', () => {
      const component = <div>Sidebar</div>;
      const segment = createSegment('parallel', 3, component, {
        slot: '@sidebar',
      });

      expect(segment.id).toBe('P3');
      expect(segment.type).toBe('parallel');
      expect(segment.index).toBe(3);
      expect(segment.slot).toBe('@sidebar');
    });

    it('should include optional path and params', () => {
      const component = <div>Post</div>;
      const segment = createSegment('route', 2, component, {
        path: '/blog/:slug',
        params: { slug: 'hello-world' },
      });

      expect(segment.path).toBe('/blog/:slug');
      expect(segment.params).toEqual({ slug: 'hello-world' });
    });
  });

  describe('Round-trip consistency', () => {
    it('should maintain consistency through generate and parse', () => {
      const id = generateSegmentId('layout', 5);
      const parsed = parseSegmentId(id);

      expect(parsed).toEqual({ type: 'layout', index: 5 });
    });

    it('should work for all segment types', () => {
      const types: SegmentType[] = ['layout', 'route', 'parallel'];

      types.forEach((type) => {
        const id = generateSegmentId(type, 10);
        const parsed = parseSegmentId(id);

        expect(parsed?.type).toBe(type);
        expect(parsed?.index).toBe(10);
      });
    });
  });
});
