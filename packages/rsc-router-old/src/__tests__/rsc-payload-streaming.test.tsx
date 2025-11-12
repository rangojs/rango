/**
 * Phase 7.6: RSC Payload Streaming
 *
 * Tests for creating and streaming RSC payloads
 */

import { describe, it, expect } from 'vitest';
import { createRSCPayload, type RSCPayload } from '../segment-system';
import type { Segment } from '../segment-system';

describe('Phase 7.6: RSC Payload Streaming', () => {
  describe('createRSCPayload()', () => {
    describe('Payload structure', () => {
      it('should create payload with segments array and updates object', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>Layout</div>,
            path: '/test',
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: () => <div>Route</div>,
            path: '/test',
          },
        ];

        const clientHas = new Set<string>();
        const payload = createRSCPayload(segments, clientHas);

        expect(payload).toHaveProperty('segments');
        expect(payload).toHaveProperty('updates');
        expect(Array.isArray(payload.segments)).toBe(true);
        expect(typeof payload.updates).toBe('object');
      });

      it('should include all segment IDs in segments array', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>Layout</div>,
            path: '/test',
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: () => <div>Layout2</div>,
            path: '/test',
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: () => <div>Route</div>,
            path: '/test',
          },
        ];

        const clientHas = new Set<string>();
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.segments).toEqual(['L0', 'L1', 'R2']);
      });

      it('should preserve segment ID order', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>L0</div>,
            path: '/test',
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: () => <div>R1</div>,
            path: '/test',
          },
          {
            id: 'P2',
            type: 'parallel',
            index: 2,
            component: () => <div>P2</div>,
            slot: '@sidebar',
            path: '/test',
          },
        ];

        const clientHas = new Set<string>();
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.segments).toEqual(['L0', 'R1', 'P2']);
      });
    });

    describe('Full render (no client state)', () => {
      it('should include all segments in updates when client has nothing', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>Layout</div>,
            path: '/test',
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: () => <div>Route</div>,
            path: '/test',
          },
        ];

        const clientHas = new Set<string>();
        const payload = createRSCPayload(segments, clientHas);

        expect(Object.keys(payload.updates)).toHaveLength(2);
        expect(payload.updates).toHaveProperty('L0');
        expect(payload.updates).toHaveProperty('R1');
      });

      it('should render all segment components in updates', () => {
        const LayoutComponent = () => <div>Layout</div>;
        const RouteComponent = () => <div>Route</div>;

        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: LayoutComponent,
            path: '/test',
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: RouteComponent,
            path: '/test',
          },
        ];

        const clientHas = new Set<string>();
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.updates.L0).toBeDefined();
        expect(payload.updates.R1).toBeDefined();
      });
    });

    describe('Partial render (with client state)', () => {
      it('should only include new segments in updates', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>Layout</div>,
            path: '/test',
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: () => <div>Route</div>,
            path: '/test',
          },
        ];

        const clientHas = new Set(['L0']); // Client already has L0
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.segments).toEqual(['L0', 'R1']);
        expect(Object.keys(payload.updates)).toHaveLength(1);
        expect(payload.updates).toHaveProperty('R1');
        expect(payload.updates).not.toHaveProperty('L0');
      });

      it('should include updated segments in updates', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>Layout</div>,
            path: '/test',
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: () => <div>Route</div>,
            path: '/test',
            params: { id: '123' }, // Different params
          },
        ];

        const clientHas = new Set(['L0', 'R1']);
        const payload = createRSCPayload(segments, clientHas);

        // Should include R1 even though client has it, because params changed
        expect(payload.updates).toHaveProperty('R1');
      });

      it('should not include unchanged segments in updates', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>Layout</div>,
            path: '/test',
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: () => <div>Layout2</div>,
            path: '/test',
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: () => <div>Route</div>,
            path: '/test',
            params: { id: '456' },
          },
        ];

        const clientHas = new Set(['L0', 'L1']);
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.segments).toEqual(['L0', 'L1', 'R2']);
        expect(payload.updates).toHaveProperty('R2');
        expect(payload.updates).not.toHaveProperty('L0');
        expect(payload.updates).not.toHaveProperty('L1');
      });
    });

    describe('Parallel routes', () => {
      it('should include parallel segments in payload', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>Layout</div>,
            path: '/test',
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: () => <div>Main</div>,
            path: '/test',
          },
          {
            id: 'P2',
            type: 'parallel',
            index: 2,
            component: () => <div>Sidebar</div>,
            slot: '@sidebar',
            path: '/test',
          },
        ];

        const clientHas = new Set<string>();
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.segments).toEqual(['L0', 'R1', 'P2']);
        expect(payload.updates).toHaveProperty('L0');
        expect(payload.updates).toHaveProperty('R1');
        expect(payload.updates).toHaveProperty('P2');
      });

      it('should handle multiple parallel segments', () => {
        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: () => <div>Main</div>,
            path: '/test',
          },
          {
            id: 'P1',
            type: 'parallel',
            index: 1,
            component: () => <div>Sidebar</div>,
            slot: '@sidebar',
            path: '/test',
          },
          {
            id: 'P2',
            type: 'parallel',
            index: 2,
            component: () => <div>Modal</div>,
            slot: '@modal',
            path: '/test',
          },
        ];

        const clientHas = new Set<string>();
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.segments).toEqual(['R0', 'P1', 'P2']);
        expect(Object.keys(payload.updates)).toHaveLength(3);
      });
    });

    describe('Edge cases', () => {
      it('should handle empty segments array', () => {
        const segments: Segment[] = [];
        const clientHas = new Set<string>();
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.segments).toEqual([]);
        expect(payload.updates).toEqual({});
      });

      it('should handle segments with null components', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: null as any,
            path: '/test',
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: () => <div>Route</div>,
            path: '/test',
          },
        ];

        const clientHas = new Set<string>();
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.segments).toEqual(['L0', 'R1']);
        // L0 should not be in updates if component is null
        expect(payload.updates).toHaveProperty('R1');
      });

      it('should handle all segments already on client', () => {
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>Layout</div>,
            path: '/test',
          },
          {
            id: 'R1',
            type: 'route',
            index: 1,
            component: () => <div>Route</div>,
            path: '/test',
          },
        ];

        const clientHas = new Set(['L0', 'R1']);
        const payload = createRSCPayload(segments, clientHas);

        expect(payload.segments).toEqual(['L0', 'R1']);
        expect(Object.keys(payload.updates)).toHaveLength(0);
      });
    });

    describe('Type safety', () => {
      it('should return correct RSCPayload type', () => {
        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: () => <div>Route</div>,
            path: '/test',
          },
        ];

        const clientHas = new Set<string>();
        const payload: RSCPayload = createRSCPayload(segments, clientHas);

        expect(payload).toBeDefined();
        expect(payload.segments).toBeDefined();
        expect(payload.updates).toBeDefined();
      });
    });
  });
});
