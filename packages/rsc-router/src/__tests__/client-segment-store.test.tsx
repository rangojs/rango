/**
 * Phase 7.7: Client Segment Store
 *
 * Tests for client-side segment tracking and state management
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SegmentStore } from '../client';
import type { Segment } from '../segment-system';

describe('Phase 7.7: Client Segment Store', () => {
  let store: SegmentStore;

  beforeEach(() => {
    store = new SegmentStore();
  });

  describe('Initialization', () => {
    it('should initialize with empty segment set', () => {
      expect(store.size()).toBe(0);
      expect(store.getAll()).toEqual([]);
      expect(store.isEmpty()).toBe(true);
    });

    it('should accept initial segments', () => {
      const initialSegments: Segment[] = [
        {
          id: 'L0',
          type: 'layout',
          index: 0,
          component: () => <div>Layout</div>,
          path: '/',
        },
        {
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/',
        },
      ];

      const storeWithInitial = new SegmentStore(initialSegments);
      expect(storeWithInitial.size()).toBe(2);
      expect(storeWithInitial.has('L0')).toBe(true);
      expect(storeWithInitial.has('R1')).toBe(true);
    });
  });

  describe('addSegment()', () => {
    it('should add a segment to the store', () => {
      const segment: Segment = {
        id: 'L0',
        type: 'layout',
        index: 0,
        component: () => <div>Layout</div>,
        path: '/test',
      };

      store.addSegment(segment);

      expect(store.size()).toBe(1);
      expect(store.has('L0')).toBe(true);
    });

    it('should add multiple segments', () => {
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
        {
          id: 'P2',
          type: 'parallel',
          index: 2,
          component: () => <div>Parallel</div>,
          slot: '@sidebar',
          path: '/test',
        },
      ];

      segments.forEach((seg) => store.addSegment(seg));

      expect(store.size()).toBe(3);
      expect(store.has('L0')).toBe(true);
      expect(store.has('R1')).toBe(true);
      expect(store.has('P2')).toBe(true);
    });

    it('should replace existing segment with same ID', () => {
      const segment1: Segment = {
        id: 'R0',
        type: 'route',
        index: 0,
        component: () => <div>Old</div>,
        path: '/old',
      };

      const segment2: Segment = {
        id: 'R0',
        type: 'route',
        index: 0,
        component: () => <div>New</div>,
        path: '/new',
      };

      store.addSegment(segment1);
      expect(store.get('R0')).toEqual(segment1);

      store.addSegment(segment2);
      expect(store.get('R0')).toEqual(segment2);
      expect(store.size()).toBe(1); // Still only one segment
    });
  });

  describe('removeSegment()', () => {
    beforeEach(() => {
      store.addSegment({
        id: 'L0',
        type: 'layout',
        index: 0,
        component: () => <div>Layout</div>,
        path: '/test',
      });
      store.addSegment({
        id: 'R1',
        type: 'route',
        index: 1,
        component: () => <div>Route</div>,
        path: '/test',
      });
    });

    it('should remove a segment by ID', () => {
      expect(store.has('L0')).toBe(true);

      store.removeSegment('L0');

      expect(store.has('L0')).toBe(false);
      expect(store.size()).toBe(1);
    });

    it('should handle removing non-existent segment', () => {
      expect(store.size()).toBe(2);

      store.removeSegment('NONEXISTENT');

      expect(store.size()).toBe(2); // Size unchanged
    });

    it('should remove multiple segments', () => {
      store.removeSegment('L0');
      store.removeSegment('R1');

      expect(store.isEmpty()).toBe(true);
      expect(store.size()).toBe(0);
    });
  });

  describe('updateSegment()', () => {
    beforeEach(() => {
      store.addSegment({
        id: 'R0',
        type: 'route',
        index: 0,
        component: () => <div>Original</div>,
        path: '/original',
      });
    });

    it('should update an existing segment', () => {
      const updatedSegment: Segment = {
        id: 'R0',
        type: 'route',
        index: 0,
        component: () => <div>Updated</div>,
        path: '/updated',
      };

      store.updateSegment('R0', updatedSegment);

      const stored = store.get('R0');
      expect(stored).toEqual(updatedSegment);
    });

    it('should add segment if it does not exist', () => {
      const newSegment: Segment = {
        id: 'L1',
        type: 'layout',
        index: 1,
        component: () => <div>New</div>,
        path: '/new',
      };

      expect(store.has('L1')).toBe(false);

      store.updateSegment('L1', newSegment);

      expect(store.has('L1')).toBe(true);
      expect(store.get('L1')).toEqual(newSegment);
    });
  });

  describe('has()', () => {
    beforeEach(() => {
      store.addSegment({
        id: 'L0',
        type: 'layout',
        index: 0,
        component: () => <div>Layout</div>,
        path: '/test',
      });
    });

    it('should return true for existing segment', () => {
      expect(store.has('L0')).toBe(true);
    });

    it('should return false for non-existing segment', () => {
      expect(store.has('R1')).toBe(false);
      expect(store.has('INVALID')).toBe(false);
    });
  });

  describe('get()', () => {
    const testSegment: Segment = {
      id: 'R0',
      type: 'route',
      index: 0,
      component: () => <div>Test</div>,
      path: '/test',
    };

    beforeEach(() => {
      store.addSegment(testSegment);
    });

    it('should return segment by ID', () => {
      const segment = store.get('R0');
      expect(segment).toEqual(testSegment);
    });

    it('should return undefined for non-existing segment', () => {
      const segment = store.get('NONEXISTENT');
      expect(segment).toBeUndefined();
    });
  });

  describe('getAll()', () => {
    it('should return empty array when store is empty', () => {
      expect(store.getAll()).toEqual([]);
    });

    it('should return all segments', () => {
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

      segments.forEach((seg) => store.addSegment(seg));

      const all = store.getAll();
      expect(all).toHaveLength(2);
      expect(all).toEqual(expect.arrayContaining(segments));
    });

    it('should return segments in order by index', () => {
      // Add out of order
      store.addSegment({
        id: 'R2',
        type: 'route',
        index: 2,
        component: () => <div>R2</div>,
        path: '/test',
      });
      store.addSegment({
        id: 'L0',
        type: 'layout',
        index: 0,
        component: () => <div>L0</div>,
        path: '/test',
      });
      store.addSegment({
        id: 'L1',
        type: 'layout',
        index: 1,
        component: () => <div>L1</div>,
        path: '/test',
      });

      const all = store.getAll();
      expect(all.map((s) => s.id)).toEqual(['L0', 'L1', 'R2']);
    });
  });

  describe('getIds()', () => {
    it('should return empty array when store is empty', () => {
      expect(store.getIds()).toEqual([]);
    });

    it('should return all segment IDs', () => {
      store.addSegment({
        id: 'L0',
        type: 'layout',
        index: 0,
        component: () => <div>Layout</div>,
        path: '/test',
      });
      store.addSegment({
        id: 'R1',
        type: 'route',
        index: 1,
        component: () => <div>Route</div>,
        path: '/test',
      });

      const ids = store.getIds();
      expect(ids).toEqual(['L0', 'R1']);
    });

    it('should return IDs in order by index', () => {
      store.addSegment({
        id: 'R2',
        type: 'route',
        index: 2,
        component: () => <div>R2</div>,
        path: '/test',
      });
      store.addSegment({
        id: 'L0',
        type: 'layout',
        index: 0,
        component: () => <div>L0</div>,
        path: '/test',
      });

      const ids = store.getIds();
      expect(ids).toEqual(['L0', 'R2']);
    });
  });

  describe('clear()', () => {
    beforeEach(() => {
      store.addSegment({
        id: 'L0',
        type: 'layout',
        index: 0,
        component: () => <div>Layout</div>,
        path: '/test',
      });
      store.addSegment({
        id: 'R1',
        type: 'route',
        index: 1,
        component: () => <div>Route</div>,
        path: '/test',
      });
    });

    it('should remove all segments', () => {
      expect(store.size()).toBe(2);

      store.clear();

      expect(store.size()).toBe(0);
      expect(store.isEmpty()).toBe(true);
      expect(store.getAll()).toEqual([]);
    });
  });

  describe('size() and isEmpty()', () => {
    it('should return 0 and true when empty', () => {
      expect(store.size()).toBe(0);
      expect(store.isEmpty()).toBe(true);
    });

    it('should return correct size and false when not empty', () => {
      store.addSegment({
        id: 'L0',
        type: 'layout',
        index: 0,
        component: () => <div>Layout</div>,
        path: '/test',
      });

      expect(store.size()).toBe(1);
      expect(store.isEmpty()).toBe(false);

      store.addSegment({
        id: 'R1',
        type: 'route',
        index: 1,
        component: () => <div>Route</div>,
        path: '/test',
      });

      expect(store.size()).toBe(2);
      expect(store.isEmpty()).toBe(false);
    });
  });

  describe('Reconciliation', () => {
    beforeEach(() => {
      // Initial state: L0, R1, P2
      store.addSegment({
        id: 'L0',
        type: 'layout',
        index: 0,
        component: () => <div>L0</div>,
        path: '/test',
      });
      store.addSegment({
        id: 'R1',
        type: 'route',
        index: 1,
        component: () => <div>R1</div>,
        path: '/test',
      });
      store.addSegment({
        id: 'P2',
        type: 'parallel',
        index: 2,
        component: () => <div>P2</div>,
        slot: '@sidebar',
        path: '/test',
      });
    });

    it('should reconcile with server segment list', () => {
      // Server says we should have: L0, R1, R3 (P2 removed, R3 added)
      const serverSegmentIds = ['L0', 'R1', 'R3'];

      store.reconcile(serverSegmentIds);

      expect(store.has('L0')).toBe(true); // Kept
      expect(store.has('R1')).toBe(true); // Kept
      expect(store.has('P2')).toBe(false); // Removed (not in server list)
      expect(store.has('R3')).toBe(false); // Not added (we don't have the segment yet)
      expect(store.size()).toBe(2); // Only L0 and R1
    });

    it('should remove all segments when server list is empty', () => {
      store.reconcile([]);

      expect(store.isEmpty()).toBe(true);
    });

    it('should keep all segments when they match server list', () => {
      const serverSegmentIds = ['L0', 'R1', 'P2'];

      store.reconcile(serverSegmentIds);

      expect(store.size()).toBe(3);
      expect(store.has('L0')).toBe(true);
      expect(store.has('R1')).toBe(true);
      expect(store.has('P2')).toBe(true);
    });
  });
});
