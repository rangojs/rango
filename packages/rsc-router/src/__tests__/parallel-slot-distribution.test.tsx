/**
 * Phase 8.1: Parallel Route Slot Distribution
 *
 * Tests for parallel route slot rendering and distribution
 */

import { describe, it, expect } from 'vitest';
import { extractParallelSlots, buildSegmentMap } from '../segment-system';
import { route } from '../route-definition';

describe('Phase 8.1: Parallel Route Slot Distribution', () => {
  describe('extractParallelSlots()', () => {
    describe('Global parallel routes', () => {
      it('should extract single parallel slot', () => {
        const SidebarComponent = () => <div>Sidebar</div>;

        const handlers = {
          [route.parallel]: {
            '@sidebar': SidebarComponent,
          },
          index: () => <div>Index</div>,
        };

        const slots = extractParallelSlots(handlers);

        expect(slots).toHaveProperty('@sidebar');
        expect(slots['@sidebar']).toBe(SidebarComponent);
      });

      it('should extract multiple parallel slots', () => {
        const SidebarComponent = () => <div>Sidebar</div>;
        const ModalComponent = () => <div>Modal</div>;
        const HeaderComponent = () => <div>Header</div>;

        const handlers = {
          [route.parallel]: {
            '@sidebar': SidebarComponent,
            '@modal': ModalComponent,
            '@header': HeaderComponent,
          },
          index: () => <div>Index</div>,
        };

        const slots = extractParallelSlots(handlers);

        expect(Object.keys(slots)).toHaveLength(3);
        expect(slots['@sidebar']).toBe(SidebarComponent);
        expect(slots['@modal']).toBe(ModalComponent);
        expect(slots['@header']).toBe(HeaderComponent);
      });

      it('should return empty object when no parallel routes defined', () => {
        const handlers = {
          index: () => <div>Index</div>,
        };

        const slots = extractParallelSlots(handlers);

        expect(slots).toEqual({});
      });

      it('should enforce @ prefix on slot names', () => {
        const handlers = {
          [route.parallel]: {
            '@sidebar': () => <div>Sidebar</div>,
          },
        };

        const slots = extractParallelSlots(handlers);

        expect(Object.keys(slots)[0]).toMatch(/^@/);
      });
    });

    describe('Per-route parallel routes', () => {
      it('should extract per-route parallel slots', () => {
        const DashboardSidebar = () => <div>Dashboard Sidebar</div>;

        const handlers = {
          dashboard: {
            [route.parallel]: {
              '@sidebar': DashboardSidebar,
            },
            handler: () => <div>Dashboard</div>,
          },
        };

        const slots = extractParallelSlots(handlers, 'dashboard');

        expect(slots['@sidebar']).toBe(DashboardSidebar);
      });

      it('should extract multiple per-route slots', () => {
        const handlers = {
          dashboard: {
            [route.parallel]: {
              '@sidebar': () => <div>Sidebar</div>,
              '@notifications': () => <div>Notifications</div>,
            },
            handler: () => <div>Dashboard</div>,
          },
        };

        const slots = extractParallelSlots(handlers, 'dashboard');

        expect(Object.keys(slots)).toHaveLength(2);
        expect(slots['@sidebar']).toBeDefined();
        expect(slots['@notifications']).toBeDefined();
      });

      it('should prefer per-route over global parallel routes', () => {
        const GlobalSidebar = () => <div>Global Sidebar</div>;
        const DashboardSidebar = () => <div>Dashboard Sidebar</div>;

        const handlers = {
          [route.parallel]: {
            '@sidebar': GlobalSidebar,
          },
          dashboard: {
            [route.parallel]: {
              '@sidebar': DashboardSidebar,
            },
            handler: () => <div>Dashboard</div>,
          },
        };

        const slots = extractParallelSlots(handlers, 'dashboard');

        expect(slots['@sidebar']).toBe(DashboardSidebar);
      });

      it('should merge global and per-route slots', () => {
        const handlers = {
          [route.parallel]: {
            '@sidebar': () => <div>Global Sidebar</div>,
          },
          dashboard: {
            [route.parallel]: {
              '@notifications': () => <div>Notifications</div>,
            },
            handler: () => <div>Dashboard</div>,
          },
        };

        const slots = extractParallelSlots(handlers, 'dashboard');

        expect(Object.keys(slots)).toHaveLength(2);
        expect(slots['@sidebar']).toBeDefined();
        expect(slots['@notifications']).toBeDefined();
      });
    });
  });

  describe('buildSegmentMap() with parallel routes', () => {
    it('should create P segments for parallel routes', () => {
      const handlers = {
        [route.parallel]: {
          '@sidebar': () => <div>Sidebar</div>,
          '@modal': () => <div>Modal</div>,
        },
        index: () => <div>Index</div>,
      };

      const match = {
        pathname: '/dashboard',
        params: {},
        handlers,
      };

      const segments = buildSegmentMap(match);

      const parallelSegments = segments.filter((s) => s.type === 'parallel');
      expect(parallelSegments).toHaveLength(2);

      // Order matches insertion order in handlers object
      expect(parallelSegments[0]?.slot).toBe('@sidebar');
      expect(parallelSegments[1]?.slot).toBe('@modal');
    });

    it('should assign sequential indices to parallel segments', () => {
      const handlers = {
        [route.layout]: () => <div>Layout</div>,
        [route.parallel]: {
          '@sidebar': () => <div>Sidebar</div>,
        },
        index: () => <div>Index</div>,
      };

      const match = {
        pathname: '/test',
        params: {},
        handlers,
      };

      const segments = buildSegmentMap(match);

      // L0 (layout), R1 (route), P2 (parallel)
      expect(segments[0]?.id).toBe('L0');
      expect(segments[1]?.id).toBe('R1');
      expect(segments[2]?.id).toBe('P2');
    });

    it('should preserve parallel route order', () => {
      const handlers = {
        [route.parallel]: {
          '@first': () => <div>First</div>,
          '@second': () => <div>Second</div>,
          '@third': () => <div>Third</div>,
        },
        index: () => <div>Index</div>,
      };

      const match = {
        pathname: '/test',
        params: {},
        handlers,
      };

      const segments = buildSegmentMap(match);

      const parallelSegments = segments.filter((s) => s.type === 'parallel');
      const slots = parallelSegments.map((s) => s.slot);

      expect(slots).toEqual(['@first', '@second', '@third']);
    });

    it('should pass params to parallel route segments', () => {
      const handlers = {
        [route.parallel]: {
          '@sidebar': () => <div>Sidebar</div>,
        },
        show: () => <div>Show</div>,
      };

      const match = {
        pathname: '/posts/123',
        params: { id: '123' },
        handlers,
      };

      const segments = buildSegmentMap(match);

      const parallelSegment = segments.find((s) => s.type === 'parallel');
      expect(parallelSegment?.params).toEqual({ id: '123' });
    });
  });

  describe('Integration with segment rendering', () => {
    it('should include parallel segments in full segment map', () => {
      const handlers = {
        [route.layout]: () => <div>Layout</div>,
        [route.parallel]: {
          '@sidebar': () => <div>Sidebar</div>,
          '@modal': () => <div>Modal</div>,
        },
        index: () => <div>Index</div>,
      };

      const match = {
        pathname: '/dashboard',
        params: {},
        handlers,
      };

      const segments = buildSegmentMap(match);

      expect(segments).toHaveLength(4); // L0, R1, P2, P3
      expect(segments.filter((s) => s.type === 'layout')).toHaveLength(1);
      expect(segments.filter((s) => s.type === 'route')).toHaveLength(1);
      expect(segments.filter((s) => s.type === 'parallel')).toHaveLength(2);
    });
  });
});
