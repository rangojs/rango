/**
 * Phase 7.4: Segment Map Building Tests
 *
 * Building segment maps is the foundation for server-side rendering.
 * A segment map represents the complete hierarchy of segments for a route,
 * including layouts, route content, and parallel routes.
 *
 * This phase focuses on the data structure building - the actual rendering
 * with React Server Components is application-specific and handled by the
 * framework using this router.
 *
 * Test Coverage:
 * - Build segment map from route match
 * - Handle single layout
 * - Handle layout arrays (nested layouts)
 * - Handle parallel routes
 * - Handle route params
 * - Segment ordering and indexing
 * - Integration with existing router
 */

import { describe, it, expect } from 'vitest';
import type { Segment, RouteMatch } from '../segment-system';
import { buildSegmentMap } from '../segment-system';

describe('Phase 7.4: Segment Map Building', () => {
  describe('buildSegmentMap()', () => {
    describe('Basic segment building', () => {
      it('should build segment map with single layout', () => {
        const match: RouteMatch = {
          pathname: '/about',
          params: {},
          handlers: {
            layout: <div>Layout</div>,
            index: <div>About Page</div>,
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(2);
        expect(segments[0].id).toBe('L0');
        expect(segments[0].type).toBe('layout');
        expect(segments[0].index).toBe(0);
        expect(segments[1].id).toBe('R1');
        expect(segments[1].type).toBe('route');
        expect(segments[1].index).toBe(1);
      });

      it('should build segment map with layout array', () => {
        const match: RouteMatch = {
          pathname: '/blog',
          params: {},
          handlers: {
            layout: [
              <div>Root Layout</div>,
              <div>App Layout</div>,
              <div>Blog Layout</div>,
            ],
            index: <div>Blog Index</div>,
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(4);
        // Three layouts
        expect(segments[0]).toMatchObject({ id: 'L0', type: 'layout', index: 0 });
        expect(segments[1]).toMatchObject({ id: 'L1', type: 'layout', index: 1 });
        expect(segments[2]).toMatchObject({ id: 'L2', type: 'layout', index: 2 });
        // One route
        expect(segments[3]).toMatchObject({ id: 'R3', type: 'route', index: 3 });
      });

      it('should build segment map with no layout', () => {
        const match: RouteMatch = {
          pathname: '/simple',
          params: {},
          handlers: {
            index: <div>Simple Page</div>,
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(1);
        expect(segments[0]).toMatchObject({ id: 'R0', type: 'route', index: 0 });
      });
    });

    describe('Parallel routes', () => {
      it('should build segment map with parallel routes', () => {
        const match: RouteMatch = {
          pathname: '/dashboard',
          params: {},
          handlers: {
            layout: <div>Dashboard Layout</div>,
            index: <div>Dashboard Main</div>,
            parallel: {
              '@sidebar': <div>Sidebar</div>,
              '@notifications': <div>Notifications</div>,
            },
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(4);
        expect(segments[0]).toMatchObject({ id: 'L0', type: 'layout', index: 0 });
        expect(segments[1]).toMatchObject({ id: 'R1', type: 'route', index: 1 });
        // Parallel routes in insertion order: @sidebar, @notifications
        expect(segments[2]).toMatchObject({
          id: 'P2',
          type: 'parallel',
          index: 2,
          slot: '@sidebar',
        });
        expect(segments[3]).toMatchObject({
          id: 'P3',
          type: 'parallel',
          index: 3,
          slot: '@notifications',
        });
      });

      it('should handle parallel routes without layout', () => {
        const match: RouteMatch = {
          pathname: '/modal',
          params: {},
          handlers: {
            index: <div>Modal Page</div>,
            parallel: {
              '@modal': <div>Modal Content</div>,
            },
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(2);
        expect(segments[0]).toMatchObject({ id: 'R0', type: 'route', index: 0 });
        expect(segments[1]).toMatchObject({
          id: 'P1',
          type: 'parallel',
          index: 1,
          slot: '@modal',
        });
      });

      it('should handle multiple parallel routes in insertion order', () => {
        const match: RouteMatch = {
          pathname: '/dashboard',
          params: {},
          handlers: {
            index: <div>Dashboard</div>,
            parallel: {
              '@sidebar': <div>Sidebar</div>,
              '@modal': <div>Modal</div>,
              '@notifications': <div>Notifications</div>,
              '@chat': <div>Chat</div>,
            },
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(5);
        expect(segments[0]).toMatchObject({ id: 'R0', type: 'route' });

        // Parallel routes should be in insertion order
        const parallelSegments = segments.slice(1);
        const slots = parallelSegments.map((s) => s.slot);
        expect(slots).toEqual(['@sidebar', '@modal', '@notifications', '@chat']);
      });
    });

    describe('Route params', () => {
      it('should include params in segments', () => {
        const match: RouteMatch = {
          pathname: '/blog/hello-world',
          params: { slug: 'hello-world' },
          handlers: {
            layout: <div>Blog Layout</div>,
            show: <div>Blog Post</div>,
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(2);
        expect(segments[0].params).toBeUndefined(); // Layout has no params
        expect(segments[1].params).toEqual({ slug: 'hello-world' });
      });

      it('should include params in parallel routes', () => {
        const match: RouteMatch = {
          pathname: '/blog/post-123',
          params: { id: 'post-123' },
          handlers: {
            show: <div>Post</div>,
            parallel: {
              '@comments': <div>Comments</div>,
            },
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(2);
        expect(segments[0].params).toEqual({ id: 'post-123' });
        expect(segments[1].params).toEqual({ id: 'post-123' }); // Parallel routes also get params
      });
    });

    describe('Pathname inclusion', () => {
      it('should include pathname in all segments', () => {
        const match: RouteMatch = {
          pathname: '/blog/123/author/456',
          params: { slug: '123', authorId: '456' },
          handlers: {
            layout: [<div>Blog Layout</div>, <div>Author Layout</div>],
            show: <div>Author Page</div>,
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(3);
        segments.forEach((segment) => {
          expect(segment.path).toBe('/blog/123/author/456');
        });
      });
    });

    describe('Component assignment', () => {
      it('should assign layout components correctly', () => {
        const RootLayout = <div>Root</div>;
        const BlogLayout = <div>Blog</div>;

        const match: RouteMatch = {
          pathname: '/blog',
          params: {},
          handlers: {
            layout: [RootLayout, BlogLayout],
            index: <div>Blog Index</div>,
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments[0].component).toBe(RootLayout);
        expect(segments[1].component).toBe(BlogLayout);
      });

      it('should assign route component correctly', () => {
        const AboutPage = <div>About</div>;

        const match: RouteMatch = {
          pathname: '/about',
          params: {},
          handlers: {
            index: AboutPage,
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments[0].component).toBe(AboutPage);
      });

      it('should assign parallel route components correctly', () => {
        const Sidebar = <div>Sidebar</div>;
        const Modal = <div>Modal</div>;

        const match: RouteMatch = {
          pathname: '/dashboard',
          params: {},
          handlers: {
            index: <div>Dashboard</div>,
            parallel: {
              '@sidebar': Sidebar,
              '@modal': Modal,
            },
          },
        };

        const segments = buildSegmentMap(match);

        const sidebarSegment = segments.find((s) => s.slot === '@sidebar');
        const modalSegment = segments.find((s) => s.slot === '@modal');

        expect(sidebarSegment?.component).toBe(Sidebar);
        expect(modalSegment?.component).toBe(Modal);
      });
    });

    describe('Complex scenarios', () => {
      it('should handle full route with all features', () => {
        const match: RouteMatch = {
          pathname: '/blog/123/author/456',
          params: { slug: '123', authorId: '456' },
          handlers: {
            layout: [
              <div>Root Layout</div>,
              <div>Blog Layout</div>,
              <div>Author Layout</div>,
            ],
            show: <div>Author Page</div>,
            parallel: {
              '@sidebar': <div>Author Sidebar</div>,
              '@related': <div>Related Authors</div>,
            },
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(6);
        expect(segments[0]).toMatchObject({ id: 'L0', type: 'layout', index: 0 });
        expect(segments[1]).toMatchObject({ id: 'L1', type: 'layout', index: 1 });
        expect(segments[2]).toMatchObject({ id: 'L2', type: 'layout', index: 2 });
        expect(segments[3]).toMatchObject({ id: 'R3', type: 'route', index: 3 });
        // Parallel routes in insertion order: @sidebar, @related
        expect(segments[4]).toMatchObject({
          id: 'P4',
          type: 'parallel',
          index: 4,
          slot: '@sidebar',
        });
        expect(segments[5]).toMatchObject({
          id: 'P5',
          type: 'parallel',
          index: 5,
          slot: '@related',
        });
      });

      it('should handle nested route params in different segments', () => {
        const match: RouteMatch = {
          pathname: '/shop/electronics/123',
          params: { category: 'electronics', id: '123' },
          handlers: {
            layout: <div>Shop Layout</div>,
            show: <div>Product Page</div>,
          },
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(2);
        expect(segments[1].params).toEqual({
          category: 'electronics',
          id: '123',
        });
      });
    });

    describe('Edge cases', () => {
      it('should handle empty handlers object', () => {
        const match: RouteMatch = {
          pathname: '/empty',
          params: {},
          handlers: {},
        };

        const segments = buildSegmentMap(match);

        expect(segments).toHaveLength(0);
      });

      it('should handle null/undefined components gracefully', () => {
        const match: RouteMatch = {
          pathname: '/null',
          params: {},
          handlers: {
            index: null,
          },
        };

        const segments = buildSegmentMap(match);

        // Should still create segment even with null component
        expect(segments).toHaveLength(1);
        expect(segments[0].component).toBeNull();
      });

      it('should handle empty layout array', () => {
        const match: RouteMatch = {
          pathname: '/empty-layout',
          params: {},
          handlers: {
            layout: [],
            index: <div>Page</div>,
          },
        };

        const segments = buildSegmentMap(match);

        // Should only have route segment
        expect(segments).toHaveLength(1);
        expect(segments[0]).toMatchObject({ id: 'R0', type: 'route' });
      });

      it('should handle empty parallel routes object', () => {
        const match: RouteMatch = {
          pathname: '/empty-parallel',
          params: {},
          handlers: {
            index: <div>Page</div>,
            parallel: {},
          },
        };

        const segments = buildSegmentMap(match);

        // Should only have route segment
        expect(segments).toHaveLength(1);
        expect(segments[0]).toMatchObject({ id: 'R0', type: 'route' });
      });
    });

    describe('Return value structure', () => {
      it('should return array of segments', () => {
        const match: RouteMatch = {
          pathname: '/test',
          params: {},
          handlers: {
            index: <div>Test</div>,
          },
        };

        const segments = buildSegmentMap(match);

        expect(Array.isArray(segments)).toBe(true);
      });

      it('should return segments with all required properties', () => {
        const match: RouteMatch = {
          pathname: '/test',
          params: { id: '123' },
          handlers: {
            show: <div>Test</div>,
          },
        };

        const segments = buildSegmentMap(match);

        const segment = segments[0];
        expect(segment).toHaveProperty('id');
        expect(segment).toHaveProperty('type');
        expect(segment).toHaveProperty('index');
        expect(segment).toHaveProperty('component');
        expect(segment).toHaveProperty('path');
        expect(segment).toHaveProperty('params');
      });

      it('should return segments in rendering order', () => {
        const match: RouteMatch = {
          pathname: '/test',
          params: {},
          handlers: {
            layout: [<div>L1</div>, <div>L2</div>, <div>L3</div>],
            index: <div>Route</div>,
            parallel: {
              '@sidebar': <div>Sidebar</div>,
            },
          },
        };

        const segments = buildSegmentMap(match);

        // Should be ordered: layouts first, then route, then parallel
        const types = segments.map((s) => s.type);
        expect(types).toEqual(['layout', 'layout', 'layout', 'route', 'parallel']);

        // Indices should be sequential
        const indices = segments.map((s) => s.index);
        expect(indices).toEqual([0, 1, 2, 3, 4]);
      });
    });
  });
});
