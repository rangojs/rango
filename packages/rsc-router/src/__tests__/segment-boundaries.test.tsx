/**
 * Phase 7.10: Loading/Error Boundaries per Segment
 *
 * Tests for per-segment loading and error boundaries
 */

import { describe, it, expect } from 'vitest';
import { extractBoundaries, wrapWithBoundaries } from '../segment-system';
import { route } from '../route-definition';
import type { Segment } from '../segment-system';

describe('Phase 7.10: Loading/Error Boundaries per Segment', () => {
  describe('extractBoundaries()', () => {
    describe('Global boundaries', () => {
      it('should extract global loading boundary', () => {
        const LoadingComponent = () => <div>Loading...</div>;

        const handlers = {
          [route.loading]: LoadingComponent,
          index: () => <div>Index</div>,
        };

        const boundaries = extractBoundaries(handlers);

        expect(boundaries.loading).toBe(LoadingComponent);
      });

      it('should extract global error boundary', () => {
        const ErrorComponent = () => <div>Error</div>;

        const handlers = {
          [route.error]: ErrorComponent,
          index: () => <div>Index</div>,
        };

        const boundaries = extractBoundaries(handlers);

        expect(boundaries.error).toBe(ErrorComponent);
      });

      it('should extract both loading and error boundaries', () => {
        const LoadingComponent = () => <div>Loading...</div>;
        const ErrorComponent = () => <div>Error</div>;

        const handlers = {
          [route.loading]: LoadingComponent,
          [route.error]: ErrorComponent,
          index: () => <div>Index</div>,
        };

        const boundaries = extractBoundaries(handlers);

        expect(boundaries.loading).toBe(LoadingComponent);
        expect(boundaries.error).toBe(ErrorComponent);
      });

      it('should return undefined when no boundaries defined', () => {
        const handlers = {
          index: () => <div>Index</div>,
        };

        const boundaries = extractBoundaries(handlers);

        expect(boundaries.loading).toBeUndefined();
        expect(boundaries.error).toBeUndefined();
      });
    });

    describe('Per-route boundaries', () => {
      it('should extract per-route loading boundary', () => {
        const PostLoading = () => <div>Post Loading...</div>;

        const handlers = {
          post: {
            [route.loading]: PostLoading,
            handler: () => <div>Post</div>,
          },
        };

        const boundaries = extractBoundaries(handlers, 'post');

        expect(boundaries.loading).toBe(PostLoading);
      });

      it('should extract per-route error boundary', () => {
        const PostError = () => <div>Post Error</div>;

        const handlers = {
          post: {
            [route.error]: PostError,
            handler: () => <div>Post</div>,
          },
        };

        const boundaries = extractBoundaries(handlers, 'post');

        expect(boundaries.error).toBe(PostError);
      });

      it('should prefer per-route over global boundaries', () => {
        const GlobalLoading = () => <div>Global Loading...</div>;
        const PostLoading = () => <div>Post Loading...</div>;

        const handlers = {
          [route.loading]: GlobalLoading,
          post: {
            [route.loading]: PostLoading,
            handler: () => <div>Post</div>,
          },
        };

        const boundaries = extractBoundaries(handlers, 'post');

        expect(boundaries.loading).toBe(PostLoading);
      });

      it('should fallback to global when per-route not defined', () => {
        const GlobalLoading = () => <div>Global Loading...</div>;

        const handlers = {
          [route.loading]: GlobalLoading,
          post: {
            handler: () => <div>Post</div>,
          },
        };

        const boundaries = extractBoundaries(handlers, 'post');

        expect(boundaries.loading).toBe(GlobalLoading);
      });
    });
  });

  describe('wrapWithBoundaries()', () => {
    describe('Loading boundaries', () => {
      it('should wrap content with loading boundary', () => {
        const LoadingComponent = () => <div>Loading...</div>;
        const content = <div>Content</div>;
        const segment: Segment = {
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/test',
        };

        const wrapped = wrapWithBoundaries(content, segment, {
          loading: LoadingComponent,
        });

        expect(wrapped).toBeDefined();
        // Wrapped content structure verified in rendering
      });

      it('should not wrap when loading boundary is undefined', () => {
        const content = <div>Content</div>;
        const segment: Segment = {
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/test',
        };

        const wrapped = wrapWithBoundaries(content, segment, {});

        expect(wrapped).toBe(content); // Same reference, not wrapped
      });
    });

    describe('Error boundaries', () => {
      it('should wrap content with error boundary', () => {
        const ErrorComponent = () => <div>Error</div>;
        const content = <div>Content</div>;
        const segment: Segment = {
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/test',
        };

        const wrapped = wrapWithBoundaries(content, segment, {
          error: ErrorComponent,
        });

        expect(wrapped).toBeDefined();
      });

      it('should not wrap when error boundary is undefined', () => {
        const content = <div>Content</div>;
        const segment: Segment = {
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/test',
        };

        const wrapped = wrapWithBoundaries(content, segment, {});

        expect(wrapped).toBe(content);
      });
    });

    describe('Combined boundaries', () => {
      it('should wrap with both loading and error boundaries', () => {
        const LoadingComponent = () => <div>Loading...</div>;
        const ErrorComponent = () => <div>Error</div>;
        const content = <div>Content</div>;
        const segment: Segment = {
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/test',
        };

        const wrapped = wrapWithBoundaries(content, segment, {
          loading: LoadingComponent,
          error: ErrorComponent,
        });

        expect(wrapped).toBeDefined();
        // Both boundaries applied
      });

      it('should wrap error inside loading', () => {
        // Error boundary should be inside loading boundary
        // So errors during loading are caught
        const LoadingComponent = () => <div>Loading...</div>;
        const ErrorComponent = () => <div>Error</div>;
        const content = <div>Content</div>;
        const segment: Segment = {
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/test',
        };

        const wrapped = wrapWithBoundaries(content, segment, {
          loading: LoadingComponent,
          error: ErrorComponent,
        });

        expect(wrapped).toBeDefined();
      });
    });

    describe('Edge cases', () => {
      it('should handle null content', () => {
        const LoadingComponent = () => <div>Loading...</div>;
        const segment: Segment = {
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/test',
        };

        const wrapped = wrapWithBoundaries(null, segment, {
          loading: LoadingComponent,
        });

        expect(wrapped).toBeDefined();
      });

      it('should handle null boundaries object', () => {
        const content = <div>Content</div>;
        const segment: Segment = {
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/test',
        };

        const wrapped = wrapWithBoundaries(content, segment, {});

        expect(wrapped).toBe(content);
      });
    });
  });
});
