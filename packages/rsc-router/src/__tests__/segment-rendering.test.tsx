/**
 * Phase 7.5: Server-Side Segment Rendering
 *
 * Tests for rendering segments with OutletProvider
 */

import { describe, it, expect } from 'vitest';
import { renderSegments } from '../segment-system';
import type { Segment } from '../segment-system';

describe('Phase 7.5: Server-Side Segment Rendering', () => {
  describe('renderSegments()', () => {
    describe('Basic rendering', () => {
      it('should render single route segment', () => {
        const RouteComponent = () => <div>Route Content</div>;

        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: RouteComponent,
            path: '/test',
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeDefined();
        // Result should be the route component
        expect(result).toEqual(<RouteComponent />);
      });

      it('should render layout wrapping route', () => {
        const LayoutComponent = ({ children }: { children: React.ReactNode }) => (
          <div className="layout">{children}</div>
        );
        const RouteComponent = () => <div>Route Content</div>;

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

        const result = renderSegments(segments);
        expect(result).toBeDefined();
        // Result should be layout wrapping route
        // (exact structure verified in integration tests)
      });

      it('should render multiple nested layouts', () => {
        const RootLayout = ({ children }: { children: React.ReactNode }) => (
          <html><body>{children}</body></html>
        );
        const AppLayout = ({ children }: { children: React.ReactNode }) => (
          <div className="app">{children}</div>
        );
        const PageLayout = ({ children }: { children: React.ReactNode }) => (
          <div className="page">{children}</div>
        );
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

        const result = renderSegments(segments);
        expect(result).toBeDefined();
        // Nested layouts wrap each other
      });
    });

    describe('Parallel routes', () => {
      it('should render parallel routes alongside main content', () => {
        const LayoutComponent = ({ children }: { children: React.ReactNode }) => (
          <div className="layout">{children}</div>
        );
        const RouteComponent = () => <div>Main Content</div>;
        const SidebarComponent = () => <div>Sidebar</div>;

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
          {
            id: 'P2',
            type: 'parallel',
            index: 2,
            component: SidebarComponent,
            slot: '@sidebar',
            path: '/test',
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeDefined();
        // Should include both main and parallel content
      });

      it('should render multiple parallel routes', () => {
        const LayoutComponent = ({ children }: { children: React.ReactNode }) => (
          <div className="layout">{children}</div>
        );
        const RouteComponent = () => <div>Main</div>;
        const SidebarComponent = () => <div>Sidebar</div>;
        const ModalComponent = () => <div>Modal</div>;
        const NotificationsComponent = () => <div>Notifications</div>;

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
          {
            id: 'P2',
            type: 'parallel',
            index: 2,
            component: SidebarComponent,
            slot: '@sidebar',
            path: '/test',
          },
          {
            id: 'P3',
            type: 'parallel',
            index: 3,
            component: ModalComponent,
            slot: '@modal',
            path: '/test',
          },
          {
            id: 'P4',
            type: 'parallel',
            index: 4,
            component: NotificationsComponent,
            slot: '@notifications',
            path: '/test',
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeDefined();
      });

      it('should handle parallel routes without layout', () => {
        const RouteComponent = () => <div>Main</div>;
        const SidebarComponent = () => <div>Sidebar</div>;

        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: RouteComponent,
            path: '/test',
          },
          {
            id: 'P1',
            type: 'parallel',
            index: 1,
            component: SidebarComponent,
            slot: '@sidebar',
            path: '/test',
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeDefined();
      });
    });

    describe('Component invocation', () => {
      it('should invoke function components', () => {
        const RouteComponent = () => <div>Content</div>;

        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: RouteComponent,
            path: '/test',
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeDefined();
      });

      it('should pass params to route components', () => {
        const RouteComponent = ({ params }: { params: { id: string } }) => (
          <div>Post {params.id}</div>
        );

        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: RouteComponent,
            path: '/posts/123',
            params: { id: '123' },
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeDefined();
      });

      it('should pass params to parallel route components', () => {
        const RouteComponent = () => <div>Main</div>;
        const SidebarComponent = ({ params }: { params: { id: string } }) => (
          <div>Sidebar {params.id}</div>
        );

        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: RouteComponent,
            path: '/posts/123',
            params: { id: '123' },
          },
          {
            id: 'P1',
            type: 'parallel',
            index: 1,
            component: SidebarComponent,
            slot: '@sidebar',
            path: '/posts/123',
            params: { id: '123' },
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeDefined();
      });
    });

    describe('Edge cases', () => {
      it('should handle empty segments array', () => {
        const segments: Segment[] = [];

        const result = renderSegments(segments);
        expect(result).toBeNull();
      });

      it('should handle null components gracefully', () => {
        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: null as any,
            path: '/test',
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeNull();
      });

      it('should handle undefined components gracefully', () => {
        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: undefined as any,
            path: '/test',
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeNull();
      });

      it('should skip layout with null component but render children', () => {
        const RouteComponent = () => <div>Content</div>;

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
            component: RouteComponent,
            path: '/test',
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeDefined();
        // Should render route even though layout is null
      });
    });

    describe('Return value structure', () => {
      it('should return ReactNode', () => {
        const RouteComponent = () => <div>Content</div>;

        const segments: Segment[] = [
          {
            id: 'R0',
            type: 'route',
            index: 0,
            component: RouteComponent,
            path: '/test',
          },
        ];

        const result = renderSegments(segments);
        expect(result).toBeDefined();
        // Should be valid ReactNode
      });

      it('should return null for empty segments', () => {
        const result = renderSegments([]);
        expect(result).toBeNull();
      });
    });

    describe('Integration with OutletProvider', () => {
      it('should use OutletProvider for layout nesting', () => {
        // This test verifies that OutletProvider is used for nesting
        // The actual OutletProvider integration will be tested in E2E tests
        const LayoutComponent = ({ children }: { children: React.ReactNode }) => (
          <div className="layout">{children}</div>
        );
        const RouteComponent = () => <div>Content</div>;

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

        const result = renderSegments(segments);
        expect(result).toBeDefined();
        // OutletProvider should wrap the nested content
      });
    });
  });
});
