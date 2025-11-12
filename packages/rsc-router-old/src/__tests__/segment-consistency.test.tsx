/**
 * Tests for Segment Consistency and Ordering
 * Verifies segments are created consistently with proper ordering
 */

import { describe, it, expect } from 'vitest';
import { generateSegmentId, createSegment, parseSegmentId } from '../segment-system';

describe('Segment Consistency and Ordering', () => {
  describe('Sequential index generation', () => {
    it('should generate sequential indices starting from 0', () => {
      const segments = [
        createSegment('layout', 0, <div>L0</div>),
        createSegment('layout', 1, <div>L1</div>),
        createSegment('route', 2, <div>R2</div>),
        createSegment('parallel', 3, <div>P3</div>, { slot: '@sidebar' }),
      ];

      segments.forEach((segment, idx) => {
        expect(segment.index).toBe(idx);
      });
    });

    it('should maintain index continuity', () => {
      const ids = ['L0', 'L1', 'R2', 'L3', 'R4', 'P5', 'P6'];

      ids.forEach((id, idx) => {
        const parsed = parseSegmentId(id);
        expect(parsed?.index).toBe(idx);
      });
    });
  });

  describe('Consistent ID generation for same route', () => {
    it('should generate same IDs for same route structure', () => {
      // First render of /blog
      const render1 = [
        generateSegmentId('layout', 0), // Root layout
        generateSegmentId('layout', 1), // Blog layout
        generateSegmentId('route', 2),  // Blog content
      ];

      // Second render of /blog
      const render2 = [
        generateSegmentId('layout', 0),
        generateSegmentId('layout', 1),
        generateSegmentId('route', 2),
      ];

      expect(render1).toEqual(render2);
    });

    it('should generate consistent IDs across renders', () => {
      // Simulate multiple renders of same route
      for (let i = 0; i < 5; i++) {
        const segments = [
          createSegment('layout', 0, <div>Root</div>),
          createSegment('layout', 1, <div>Blog</div>),
          createSegment('route', 2, <div>Post</div>),
        ];

        expect(segments[0]?.id).toBe('L0');
        expect(segments[1]?.id).toBe('L1');
        expect(segments[2]?.id).toBe('R2');
      }
    });
  });

  describe('Segment ordering rules', () => {
    it('should order layouts before routes', () => {
      const segments = [
        createSegment('layout', 0, <div>L0</div>),
        createSegment('layout', 1, <div>L1</div>),
        createSegment('route', 2, <div>R2</div>),
      ];

      // All layouts come before routes
      const layoutIndices = segments
        .filter((s) => s.type === 'layout')
        .map((s) => s.index);
      const routeIndices = segments
        .filter((s) => s.type === 'route')
        .map((s) => s.index);

      const maxLayoutIndex = Math.max(...layoutIndices);
      const minRouteIndex = Math.min(...routeIndices);

      expect(maxLayoutIndex).toBeLessThan(minRouteIndex);
    });

    it('should handle parallel segments at same level as routes', () => {
      const segments = [
        createSegment('layout', 0, <div>L0</div>),
        createSegment('route', 1, <div>R1</div>),
        createSegment('parallel', 2, <div>P2</div>, { slot: '@sidebar' }),
        createSegment('parallel', 3, <div>P3</div>, { slot: '@modal' }),
      ];

      // Parallel segments come after route content at same nesting level
      expect(segments[2]?.type).toBe('parallel');
      expect(segments[3]?.type).toBe('parallel');
    });
  });

  describe('Segment structure validation', () => {
    it('should create valid segment objects', () => {
      const segment = createSegment('layout', 0, <div>Layout</div>);

      expect(segment).toHaveProperty('id');
      expect(segment).toHaveProperty('type');
      expect(segment).toHaveProperty('index');
      expect(segment).toHaveProperty('component');
      expect(segment.id).toBe('L0');
      expect(segment.type).toBe('layout');
      expect(segment.index).toBe(0);
    });

    it('should include optional properties when provided', () => {
      const segment = createSegment('route', 2, <div>Post</div>, {
        path: '/blog/:slug',
        params: { slug: 'hello' },
      });

      expect(segment.path).toBe('/blog/:slug');
      expect(segment.params).toEqual({ slug: 'hello' });
    });

    it('should include slot for parallel segments', () => {
      const segment = createSegment('parallel', 3, <div>Sidebar</div>, {
        slot: '@sidebar',
      });

      expect(segment.slot).toBe('@sidebar');
    });
  });

  describe('Example: Blog post route segments', () => {
    it('should create consistent segment structure for /blog/:slug', () => {
      // Route: /blog/:slug with layouts
      const segments = [
        createSegment('layout', 0, <div>RootLayout</div>),
        createSegment('layout', 1, <div>BlogLayout</div>),
        createSegment('route', 2, <div>BlogPost</div>, {
          path: '/blog/:slug',
          params: { slug: 'hello-world' },
        }),
      ];

      expect(segments.map((s) => s.id)).toEqual(['L0', 'L1', 'R2']);
      expect(segments.map((s) => s.type)).toEqual(['layout', 'layout', 'route']);
      expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
    });
  });

  describe('Example: Dashboard with parallel routes', () => {
    it('should create segments for dashboard with sidebar and modal', () => {
      // Route: /dashboard with layouts and parallel routes
      const segments = [
        createSegment('layout', 0, <div>Root</div>),
        createSegment('layout', 1, <div>Dashboard</div>),
        createSegment('route', 2, <div>DashContent</div>),
        createSegment('parallel', 3, <div>Sidebar</div>, { slot: '@sidebar' }),
        createSegment('parallel', 4, <div>Modal</div>, { slot: '@modal' }),
      ];

      expect(segments.map((s) => s.id)).toEqual(['L0', 'L1', 'R2', 'P3', 'P4']);
      expect(segments[3]?.slot).toBe('@sidebar');
      expect(segments[4]?.slot).toBe('@modal');
    });
  });
});
