/**
 * Phase 7.3: Differential Computation Algorithm Tests
 *
 * The differential computation algorithm determines which segments need to be
 * sent to the client during partial rendering. It compares the client's current
 * segments with the target segments for the requested route.
 *
 * The server computes the minimal set of segments to send, sending only:
 * - Segments that don't exist on the client
 * - Segments that need revalidation (params changed, etc.)
 *
 * Test Coverage:
 * - Initial navigation (client has no segments)
 * - Same route navigation (no changes needed)
 * - Parameter change (content revalidation)
 * - Structure change (adding/removing segments)
 * - Parallel routes differential
 * - Revalidation logic
 * - Edge cases
 */

import { describe, it, expect } from 'vitest';
import type { Segment } from '../segment-system';
import { computeDifferential } from '../segment-system';

describe('Phase 7.3: Differential Computation Algorithm', () => {
  describe('computeDifferential()', () => {
    describe('Initial navigation (no client state)', () => {
      it('should send all segments when client has nothing', () => {
        const clientHas = new Set<string>();
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: <div>Layout 1</div>,
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: <div>Route 2</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        // Should return all segment IDs
        expect(result.segmentIds).toEqual(['L0', 'L1', 'R2']);

        // Should send all segments
        expect(result.updates).toHaveLength(3);
        expect(result.updates.map((s) => s.id)).toEqual(['L0', 'L1', 'R2']);
      });

      it('should handle single segment route', () => {
        const clientHas = new Set<string>();
        const targetSegments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: <div>Route 0</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['R0']);
        expect(result.updates).toHaveLength(1);
        expect(result.updates[0].id).toBe('R0');
      });
    });

    describe('Same route navigation (no changes)', () => {
      it('should send nothing when client has all segments', () => {
        const clientHas = new Set(['L0', 'L1', 'R2']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: <div>Layout 1</div>,
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: <div>Route 2</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        // Should return segment IDs for reconciliation
        expect(result.segmentIds).toEqual(['L0', 'L1', 'R2']);

        // Should send no updates (client has everything)
        expect(result.updates).toHaveLength(0);
      });
    });

    describe('Parameter changes (content revalidation)', () => {
      it('should send updated segment when params change', () => {
        const clientHas = new Set(['L0', 'L1', 'R2']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: <div>Layout 1</div>,
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: <div>Route 2 - Updated</div>,
            params: { id: '456' }, // Changed from 123 to 456
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['L0', 'L1', 'R2']);

        // Should send only R2 (changed params)
        expect(result.updates).toHaveLength(1);
        expect(result.updates[0].id).toBe('R2');
        expect(result.updates[0].params).toEqual({ id: '456' });
      });

      it('should handle multiple param changes', () => {
        const clientHas = new Set(['L0', 'R1', 'L2', 'R3']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: <div>Route 1 - Updated</div>,
            params: { slug: 'new-slug' },
          },
          {
            id: 'L2',
            type: 'layout',
            index: 2,
            component: <div>Layout 2</div>,
          },
          {
            id: 'R3',
            type: 'route',
            index: 3,
            component: <div>Route 3 - Updated</div>,
            params: { id: '789' },
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['L0', 'R1', 'L2', 'R3']);

        // Should send R1 and R3 (both have param changes)
        expect(result.updates).toHaveLength(2);
        expect(result.updates.map((s) => s.id)).toEqual(['R1', 'R3']);
      });
    });

    describe('Structure changes (adding segments)', () => {
      it('should send new segments when navigating deeper', () => {
        const clientHas = new Set(['L0', 'L1', 'R2']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: <div>Layout 1</div>,
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: <div>Route 2</div>,
          },
          {
            id: 'L3',
            type: 'layout',
            index: 3,
            component: <div>Layout 3</div>,
          },
          {
            id: 'R4',
            type: 'route',
            index: 4,
            component: <div>Route 4</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        // Extended segment list
        expect(result.segmentIds).toEqual(['L0', 'L1', 'R2', 'L3', 'R4']);

        // Should send only new segments L3 and R4
        expect(result.updates).toHaveLength(2);
        expect(result.updates.map((s) => s.id)).toEqual(['L3', 'R4']);
      });

      it('should handle adding many segments', () => {
        const clientHas = new Set(['L0']);
        const targetSegments: Segment[] = [
          { id: 'L0', type: 'layout', index: 0, component: <div>L0</div> },
          { id: 'R1', type: 'route', index: 1, component: <div>R1</div> },
          { id: 'L2', type: 'layout', index: 2, component: <div>L2</div> },
          { id: 'R3', type: 'route', index: 3, component: <div>R3</div> },
          { id: 'L4', type: 'layout', index: 4, component: <div>L4</div> },
          { id: 'R5', type: 'route', index: 5, component: <div>R5</div> },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['L0', 'R1', 'L2', 'R3', 'L4', 'R5']);

        // Should send all except L0
        expect(result.updates).toHaveLength(5);
        expect(result.updates.map((s) => s.id)).toEqual([
          'R1',
          'L2',
          'R3',
          'L4',
          'R5',
        ]);
      });
    });

    describe('Structure changes (removing segments)', () => {
      it('should not send removed segments', () => {
        const clientHas = new Set(['L0', 'L1', 'R2', 'L3', 'R4']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: <div>Layout 1</div>,
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: <div>Route 2</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        // Shorter segment list (L3, R4 removed)
        expect(result.segmentIds).toEqual(['L0', 'L1', 'R2']);

        // Should send nothing (client has all target segments)
        expect(result.updates).toHaveLength(0);
      });

      it('should handle complete segment replacement', () => {
        const clientHas = new Set(['L0', 'L1', 'R2']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: <div>Different Route</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        // Different structure
        expect(result.segmentIds).toEqual(['L0', 'R1']);

        // Should send R1 (new segment)
        expect(result.updates).toHaveLength(1);
        expect(result.updates[0].id).toBe('R1');
      });
    });

    describe('Parallel routes', () => {
      it('should handle parallel route segments', () => {
        const clientHas = new Set(['L0', 'L1', 'R2']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: <div>Layout 1</div>,
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: <div>Route 2</div>,
          },
          {
            id: 'P3',
            type: 'parallel',
            index: 3,
            component: <div>Sidebar</div>,
            slot: '@sidebar',
          },
          {
            id: 'P4',
            type: 'parallel',
            index: 4,
            component: <div>Modal</div>,
            slot: '@modal',
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['L0', 'L1', 'R2', 'P3', 'P4']);

        // Should send parallel routes P3 and P4
        expect(result.updates).toHaveLength(2);
        expect(result.updates.map((s) => s.id)).toEqual(['P3', 'P4']);
        expect(result.updates[0].slot).toBe('@sidebar');
        expect(result.updates[1].slot).toBe('@modal');
      });

      it('should update only changed parallel routes', () => {
        const clientHas = new Set(['L0', 'R1', 'P2', 'P3']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: <div>Route 1</div>,
          },
          {
            id: 'P2',
            type: 'parallel',
            index: 2,
            component: <div>Sidebar - Updated</div>,
            slot: '@sidebar',
            params: { view: 'expanded' }, // Params indicate change
          },
          {
            id: 'P3',
            type: 'parallel',
            index: 3,
            component: <div>Modal</div>,
            slot: '@modal',
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['L0', 'R1', 'P2', 'P3']);

        // Should send only P2 (has params, indicating change)
        expect(result.updates).toHaveLength(1);
        expect(result.updates[0].id).toBe('P2');
      });
    });

    describe('Mixed scenarios', () => {
      it('should handle adding layouts + changing content', () => {
        const clientHas = new Set(['L0', 'R1']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: <div>Layout 1 - New</div>,
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: <div>Route 2 - New</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['L0', 'L1', 'R2']);

        // Should send L1 and R2 (both new)
        expect(result.updates).toHaveLength(2);
        expect(result.updates.map((s) => s.id)).toEqual(['L1', 'R2']);
      });

      it('should handle partial overlap', () => {
        const clientHas = new Set(['L0', 'L1', 'R2', 'L3']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: <div>Layout 1</div>,
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: <div>Route 2 - Updated</div>,
            params: { id: 'new' },
          },
          {
            id: 'P3',
            type: 'parallel',
            index: 3,
            component: <div>Sidebar</div>,
            slot: '@sidebar',
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['L0', 'L1', 'R2', 'P3']);

        // Should send R2 (updated) and P3 (new, replaces L3)
        expect(result.updates).toHaveLength(2);
        expect(result.updates.map((s) => s.id)).toEqual(['R2', 'P3']);
      });
    });

    describe('Edge cases', () => {
      it('should handle empty target segments', () => {
        const clientHas = new Set(['L0', 'R1']);
        const targetSegments: Segment[] = [];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual([]);
        expect(result.updates).toHaveLength(0);
      });

      it('should handle client having extra segments', () => {
        const clientHas = new Set(['L0', 'L1', 'R2', 'L3', 'R4', 'P5', 'P6']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>Layout 0</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['L0']);
        expect(result.updates).toHaveLength(0);
      });

      it('should handle completely different segments', () => {
        const clientHas = new Set(['L0', 'L1', 'R2']);
        const targetSegments: Segment[] = [
          {
            id: 'L3',
            type: 'layout',
            index: 3,
            component: <div>Layout 3</div>,
          },
          {
            id: 'R4',
            type: 'route',
            index: 4,
            component: <div>Route 4</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result.segmentIds).toEqual(['L3', 'R4']);

        // Should send all target segments (client has none of them)
        expect(result.updates).toHaveLength(2);
        expect(result.updates.map((s) => s.id)).toEqual(['L3', 'R4']);
      });
    });

    describe('Return value validation', () => {
      it('should always return segmentIds and updates', () => {
        const clientHas = new Set<string>();
        const targetSegments: Segment[] = [];

        const result = computeDifferential(clientHas, targetSegments);

        expect(result).toHaveProperty('segmentIds');
        expect(result).toHaveProperty('updates');
        expect(Array.isArray(result.segmentIds)).toBe(true);
        expect(Array.isArray(result.updates)).toBe(true);
      });

      it('should maintain segment order in segmentIds', () => {
        const clientHas = new Set<string>();
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>L0</div>,
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: <div>R1</div>,
          },
          {
            id: 'L2',
            type: 'layout',
            index: 2,
            component: <div>L2</div>,
          },
          {
            id: 'P3',
            type: 'parallel',
            index: 3,
            component: <div>P3</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        // Should maintain order from targetSegments
        expect(result.segmentIds).toEqual(['L0', 'R1', 'L2', 'P3']);
      });

      it('should return updates in same order as targetSegments', () => {
        const clientHas = new Set(['L0']);
        const targetSegments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: <div>L0</div>,
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: <div>R1</div>,
          },
          {
            id: 'L2',
            type: 'layout',
            index: 2,
            component: <div>L2</div>,
          },
          {
            id: 'P3',
            type: 'parallel',
            index: 3,
            component: <div>P3</div>,
          },
        ];

        const result = computeDifferential(clientHas, targetSegments);

        // Updates should be in order: R1, L2, P3 (skipping L0 which client has)
        expect(result.updates.map((s) => s.id)).toEqual(['R1', 'L2', 'P3']);
      });
    });
  });

  describe('Real-world navigation scenarios', () => {
    it('should handle blog post to same blog post (refresh)', () => {
      // Client on /blog/123, refreshes same page
      // Note: In real implementation, segments with params would be sent
      // unless we track previous params. For now, segments with params are
      // conservatively re-sent
      const clientHas = new Set(['L0', 'L1', 'R2']);
      const targetSegments: Segment[] = [
        {
          id: 'L0',
          type: 'layout',
          index: 0,
          component: <div>Root Layout</div>,
        },
        {
          id: 'L1',
          type: 'layout',
          index: 1,
          component: <div>Blog Layout</div>,
        },
        {
          id: 'R2',
          type: 'route',
          index: 2,
          component: <div>Blog Post 123</div>,
          params: { slug: '123' },
        },
      ];

      const result = computeDifferential(clientHas, targetSegments);

      expect(result.segmentIds).toEqual(['L0', 'L1', 'R2']);
      // R2 has params, so it's conservatively re-sent
      // (future: track prev params to avoid this)
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].id).toBe('R2');
    });

    it('should handle blog post to different blog post', () => {
      // Client on /blog/123, navigates to /blog/456
      const clientHas = new Set(['L0', 'L1', 'R2']);
      const targetSegments: Segment[] = [
        {
          id: 'L0',
          type: 'layout',
          index: 0,
          component: <div>Root Layout</div>,
        },
        {
          id: 'L1',
          type: 'layout',
          index: 1,
          component: <div>Blog Layout</div>,
        },
        {
          id: 'R2',
          type: 'route',
          index: 2,
          component: <div>Blog Post 456</div>,
          params: { slug: '456' },
        },
      ];

      const result = computeDifferential(clientHas, targetSegments);

      expect(result.segmentIds).toEqual(['L0', 'L1', 'R2']);
      expect(result.updates).toHaveLength(1); // Only R2 changes
      expect(result.updates[0].id).toBe('R2');
    });

    it('should handle blog post to author page (deeper)', () => {
      // Client on /blog/123, navigates to /blog/123/author/456
      const clientHas = new Set(['L0', 'L1', 'R2']);
      const targetSegments: Segment[] = [
        {
          id: 'L0',
          type: 'layout',
          index: 0,
          component: <div>Root Layout</div>,
        },
        {
          id: 'L1',
          type: 'layout',
          index: 1,
          component: <div>Blog Layout</div>,
        },
        {
          id: 'R2',
          type: 'route',
          index: 2,
          component: <div>Blog Post 123</div>,
          params: { slug: '123' },
        },
        {
          id: 'L3',
          type: 'layout',
          index: 3,
          component: <div>Author Layout</div>,
        },
        {
          id: 'R4',
          type: 'route',
          index: 4,
          component: <div>Author 456</div>,
          params: { authorId: '456' },
        },
      ];

      const result = computeDifferential(clientHas, targetSegments);

      expect(result.segmentIds).toEqual(['L0', 'L1', 'R2', 'L3', 'R4']);
      // R2 has params (re-sent), L3 is new, R4 is new
      expect(result.updates).toHaveLength(3);
      expect(result.updates.map((s) => s.id)).toEqual(['R2', 'L3', 'R4']);
    });

    it('should handle author page back to blog post (shallower)', () => {
      // Client on /blog/123/author/456, navigates back to /blog/123
      const clientHas = new Set(['L0', 'L1', 'R2', 'L3', 'R4']);
      const targetSegments: Segment[] = [
        {
          id: 'L0',
          type: 'layout',
          index: 0,
          component: <div>Root Layout</div>,
        },
        {
          id: 'L1',
          type: 'layout',
          index: 1,
          component: <div>Blog Layout</div>,
        },
        {
          id: 'R2',
          type: 'route',
          index: 2,
          component: <div>Blog Post 123</div>,
          params: { slug: '123' },
        },
      ];

      const result = computeDifferential(clientHas, targetSegments);

      expect(result.segmentIds).toEqual(['L0', 'L1', 'R2']); // L3, R4 removed
      // R2 has params, so it's conservatively re-sent
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].id).toBe('R2');
    });

    it('should handle dashboard with parallel routes', () => {
      // Client on /dashboard (no parallel routes), navigates to /dashboard with sidebar+modal
      const clientHas = new Set(['L0', 'L1', 'R2']);
      const targetSegments: Segment[] = [
        {
          id: 'L0',
          type: 'layout',
          index: 0,
          component: <div>Root Layout</div>,
        },
        {
          id: 'L1',
          type: 'layout',
          index: 1,
          component: <div>Dashboard Layout</div>,
        },
        {
          id: 'R2',
          type: 'route',
          index: 2,
          component: <div>Dashboard Main</div>,
        },
        {
          id: 'P3',
          type: 'parallel',
          index: 3,
          component: <div>Dashboard Sidebar</div>,
          slot: '@sidebar',
        },
        {
          id: 'P4',
          type: 'parallel',
          index: 4,
          component: <div>Modal</div>,
          slot: '@modal',
        },
      ];

      const result = computeDifferential(clientHas, targetSegments);

      expect(result.segmentIds).toEqual(['L0', 'L1', 'R2', 'P3', 'P4']);
      expect(result.updates).toHaveLength(2); // P3, P4 are new
      expect(result.updates.map((s) => s.id)).toEqual(['P3', 'P4']);
    });
  });
});
