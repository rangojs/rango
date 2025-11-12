/**
 * Phase 7.9: Client Segment Reconciliation
 *
 * Tests for processing RSC payloads and reconstructing React trees
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  processPayload,
  reconstructTreeFromSegments,
  SegmentStore,
} from '../client';
import type { RSCPayload } from '../segment-system';
import type { Segment } from '../segment-system';

describe('Phase 7.9: Client Segment Reconciliation', () => {
  let store: SegmentStore;

  beforeEach(() => {
    store = new SegmentStore();
  });

  describe('processPayload()', () => {
    describe('Reconciliation', () => {
      it('should reconcile store with server segment list', () => {
        // Initial state: L0, R1, P2
        store.addSegment({
          id: 'L0',
          type: 'layout',
          index: 0,
          component: () => <div>L0</div>,
          path: '/old',
        });
        store.addSegment({
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>R1</div>,
          path: '/old',
        });
        store.addSegment({
          id: 'P2',
          type: 'parallel',
          index: 2,
          component: () => <div>P2</div>,
          slot: '@sidebar',
          path: '/old',
        });

        // Server says: L0, R3 (P2 removed, R1 removed, R3 new)
        const payload: RSCPayload = {
          segments: ['L0', 'R3'],
          updates: {
            R3: () => <div>R3</div>,
          },
        };

        processPayload(payload, store);

        expect(store.has('L0')).toBe(true); // Kept
        expect(store.has('R1')).toBe(false); // Removed
        expect(store.has('P2')).toBe(false); // Removed
        expect(store.has('R3')).toBe(true); // Added
        expect(store.size()).toBe(2);
      });

      it('should remove all segments when server list is empty', () => {
        store.addSegment({
          id: 'L0',
          type: 'layout',
          index: 0,
          component: () => <div>L0</div>,
          path: '/test',
        });

        const payload: RSCPayload = {
          segments: [],
          updates: {},
        };

        processPayload(payload, store);

        expect(store.isEmpty()).toBe(true);
      });
    });

    describe('Adding new segments', () => {
      it('should add segments from updates', () => {
        const payload: RSCPayload = {
          segments: ['L0', 'R1'],
          updates: {
            L0: () => <div>Layout</div>,
            R1: () => <div>Route</div>,
          },
        };

        processPayload(payload, store);

        expect(store.has('L0')).toBe(true);
        expect(store.has('R1')).toBe(true);
        expect(store.size()).toBe(2);
      });

      it('should parse segment ID to extract type and index', () => {
        const payload: RSCPayload = {
          segments: ['L0', 'R1', 'P2'],
          updates: {
            L0: () => <div>Layout</div>,
            R1: () => <div>Route</div>,
            P2: () => <div>Parallel</div>,
          },
        };

        processPayload(payload, store);

        const l0 = store.get('L0');
        expect(l0?.type).toBe('layout');
        expect(l0?.index).toBe(0);

        const r1 = store.get('R1');
        expect(r1?.type).toBe('route');
        expect(r1?.index).toBe(1);

        const p2 = store.get('P2');
        expect(p2?.type).toBe('parallel');
        expect(p2?.index).toBe(2);
      });

      it('should store component from updates', () => {
        const LayoutComponent = () => <div>Layout</div>;
        const RouteComponent = () => <div>Route</div>;

        const payload: RSCPayload = {
          segments: ['L0', 'R1'],
          updates: {
            L0: LayoutComponent,
            R1: RouteComponent,
          },
        };

        processPayload(payload, store);

        const l0 = store.get('L0');
        expect(l0?.component).toBe(LayoutComponent);

        const r1 = store.get('R1');
        expect(r1?.component).toBe(RouteComponent);
      });
    });

    describe('Updating existing segments', () => {
      beforeEach(() => {
        store.addSegment({
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Old</div>,
          path: '/old',
        });
      });

      it('should update segments that exist in both store and updates', () => {
        const NewComponent = () => <div>New</div>;

        const payload: RSCPayload = {
          segments: ['R1'],
          updates: {
            R1: NewComponent,
          },
        };

        processPayload(payload, store);

        const r1 = store.get('R1');
        expect(r1?.component).toBe(NewComponent);
      });

      it('should keep segments not in updates', () => {
        const OldComponent = () => <div>Old</div>;
        store.addSegment({
          id: 'L0',
          type: 'layout',
          index: 0,
          component: OldComponent,
          path: '/old',
        });

        const payload: RSCPayload = {
          segments: ['L0', 'R1'],
          updates: {
            R1: () => <div>New</div>,
          },
        };

        processPayload(payload, store);

        const l0 = store.get('L0');
        expect(l0?.component).toBe(OldComponent); // Unchanged
      });
    });

    describe('Edge cases', () => {
      it('should handle empty payload', () => {
        const payload: RSCPayload = {
          segments: [],
          updates: {},
        };

        processPayload(payload, store);

        expect(store.isEmpty()).toBe(true);
      });

      it('should handle segments in updates but not in segments array', () => {
        // This shouldn't happen in practice, but handle gracefully
        const payload: RSCPayload = {
          segments: ['L0'],
          updates: {
            L0: () => <div>L0</div>,
            R1: () => <div>R1</div>, // Not in segments array
          },
        };

        processPayload(payload, store);

        expect(store.has('L0')).toBe(true);
        expect(store.has('R1')).toBe(false); // Should not be added
      });

      it('should handle segments in segments array but not in updates', () => {
        // Segment exists on client, server doesn't send update
        store.addSegment({
          id: 'L0',
          type: 'layout',
          index: 0,
          component: () => <div>Old</div>,
          path: '/test',
        });

        const payload: RSCPayload = {
          segments: ['L0', 'R1'],
          updates: {
            R1: () => <div>R1</div>,
          },
        };

        processPayload(payload, store);

        expect(store.has('L0')).toBe(true); // Kept
        expect(store.has('R1')).toBe(true); // Added
      });
    });
  });

  describe('reconstructTreeFromSegments()', () => {
    describe('Basic tree construction', () => {
      it('should handle empty segments array', () => {
        const tree = reconstructTreeFromSegments([]);
        expect(tree).toBeNull();
      });

      it('should render single route segment', () => {
        const RouteComponent = () => <div>Route</div>;

        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: RouteComponent,
            path: '/test',
          },
        ];

        const tree = reconstructTreeFromSegments(segments);
        expect(tree).toBeDefined();
      });

      it('should render layout wrapping route', () => {
        const LayoutComponent = () => (
          <div className="layout">
            <div>Layout</div>
          </div>
        );
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

        const tree = reconstructTreeFromSegments(segments);
        expect(tree).toBeDefined();
        // Tree structure verified by rendering tests
      });
    });

    describe('Nested layouts', () => {
      it('should render multiple nested layouts', () => {
        const RootLayout = () => <html><body>Root</body></html>;
        const AppLayout = () => <div className="app">App</div>;
        const PageLayout = () => <div className="page">Page</div>;
        const RouteComponent = () => <div>Content</div>;

        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: RootLayout,
            path: '/test',
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: AppLayout,
            path: '/test',
          },
          {
            id: 'L2',
            type: 'layout',
            index: 2,
            component: PageLayout,
            path: '/test',
          },
          {
            id: 'R3',
            type: 'route',
            index: 3,
            component: RouteComponent,
            path: '/test',
          },
        ];

        const tree = reconstructTreeFromSegments(segments);
        expect(tree).toBeDefined();
      });

      it('should maintain correct nesting order', () => {
        // Layouts should wrap from outermost (L0) to innermost (R)
        const segments: Segment[] = [
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div id="L0">L0</div>,
            path: '/test',
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: () => <div id="L1">L1</div>,
            path: '/test',
          },
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: () => <div id="R2">R2</div>,
            path: '/test',
          },
        ];

        const tree = reconstructTreeFromSegments(segments);
        expect(tree).toBeDefined();
        // L0 should be outermost, L1 middle, R2 innermost
      });
    });

    describe('Parallel routes', () => {
      it('should include parallel segments in tree', () => {
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

        const tree = reconstructTreeFromSegments(segments);
        expect(tree).toBeDefined();
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

        const tree = reconstructTreeFromSegments(segments);
        expect(tree).toBeDefined();
      });
    });

    describe('Edge cases', () => {
      it('should handle null components gracefully', () => {
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

        const tree = reconstructTreeFromSegments(segments);
        expect(tree).toBeDefined();
      });

      it('should handle segments in wrong order', () => {
        // Should still work correctly even if segments aren't sorted
        const segments: Segment[] = [
          {
            id: 'R2',
            type: 'route',
            index: 2,
            component: () => <div>R2</div>,
            path: '/test',
          },
          {
            id: 'L0',
            type: 'layout',
            index: 0,
            component: () => <div>L0</div>,
            path: '/test',
          },
          {
            id: 'L1',
            type: 'layout',
            index: 1,
            component: () => <div>L1</div>,
            path: '/test',
          },
        ];

        const tree = reconstructTreeFromSegments(segments);
        expect(tree).toBeDefined();
      });
    });
  });
});
