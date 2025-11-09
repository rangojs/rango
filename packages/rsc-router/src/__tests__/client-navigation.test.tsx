/**
 * Phase 7.8: Client Navigation Protocol
 *
 * Tests for client-side navigation with _has parameter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { navigateToRoute, type NavigationOptions } from '../client';
import { SegmentStore } from '../client';

describe('Phase 7.8: Client Navigation Protocol', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('navigateToRoute()', () => {
    describe('URL construction', () => {
      it('should construct URL with pathname', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/blog/123', {
          store: new SegmentStore(),
        });

        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/blog/123'),
          expect.any(Object)
        );
      });

      it('should add _has parameter with current segments', async () => {
        const store = new SegmentStore();
        store.addSegment({
          id: 'L0',
          type: 'layout',
          index: 0,
          component: () => <div>Layout</div>,
          path: '/',
        });
        store.addSegment({
          id: 'R1',
          type: 'route',
          index: 1,
          component: () => <div>Route</div>,
          path: '/',
        });

        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/blog/123', { store });

        const callUrl = (global.fetch as any).mock.calls[0][0];
        // Check for both encoded and non-encoded versions
        expect(callUrl).toMatch(/_has=(L0,R1|L0%2CR1)/);
      });

      it('should not add _has parameter when store is empty', async () => {
        const store = new SegmentStore();

        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/blog/123', { store });

        const callUrl = (global.fetch as any).mock.calls[0][0];
        expect(callUrl).not.toContain('_has');
      });

      it('should preserve existing query parameters', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/blog/123?search=test', {
          store: new SegmentStore(),
        });

        const callUrl = (global.fetch as any).mock.calls[0][0];
        expect(callUrl).toContain('search=test');
      });

      it('should combine _has with existing query parameters', async () => {
        const store = new SegmentStore();
        store.addSegment({
          id: 'L0',
          type: 'layout',
          index: 0,
          component: () => <div>Layout</div>,
          path: '/',
        });

        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/blog/123?search=test', { store });

        const callUrl = (global.fetch as any).mock.calls[0][0];
        expect(callUrl).toContain('search=test');
        expect(callUrl).toContain('_has=L0');
      });
    });

    describe('Request headers', () => {
      it('should set Accept header to application/x-rsc', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/test', {
          store: new SegmentStore(),
        });

        expect(global.fetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Accept: 'application/x-rsc',
            }),
          })
        );
      });

      it('should merge custom headers with default headers', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/test', {
          store: new SegmentStore(),
          headers: {
            'X-Custom': 'value',
          },
        });

        expect(global.fetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Accept: 'application/x-rsc',
              'X-Custom': 'value',
            }),
          })
        );
      });

      it('should allow overriding Accept header', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/test', {
          store: new SegmentStore(),
          headers: {
            Accept: 'application/json',
          },
        });

        expect(global.fetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Accept: 'application/json',
            }),
          })
        );
      });
    });

    describe('Response handling', () => {
      it('should return RSC payload from response', async () => {
        const expectedPayload = {
          segments: ['L0', 'R1'],
          updates: {
            R1: <div>Updated</div>,
          },
        };

        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue(expectedPayload),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        const result = await navigateToRoute('/test', {
          store: new SegmentStore(),
        });

        expect(result).toEqual(expectedPayload);
      });

      it('should throw error on non-ok response', async () => {
        const mockResponse = {
          ok: false,
          status: 404,
          statusText: 'Not Found',
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await expect(
          navigateToRoute('/test', {
            store: new SegmentStore(),
          })
        ).rejects.toThrow('Navigation failed: 404 Not Found');
      });

      it('should throw error on network failure', async () => {
        (global.fetch as any).mockRejectedValue(new Error('Network error'));

        await expect(
          navigateToRoute('/test', {
            store: new SegmentStore(),
          })
        ).rejects.toThrow('Network error');
      });
    });

    describe('Options', () => {
      it('should accept baseUrl option', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/test', {
          store: new SegmentStore(),
          baseUrl: 'https://api.example.com',
        });

        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('https://api.example.com/test'),
          expect.any(Object)
        );
      });

      it('should use current origin when baseUrl not provided', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/test', {
          store: new SegmentStore(),
        });

        const callUrl = (global.fetch as any).mock.calls[0][0];
        // Should be a full URL or relative path
        expect(typeof callUrl).toBe('string');
      });

      it('should pass through fetch options', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/test', {
          store: new SegmentStore(),
          signal: new AbortController().signal,
        });

        expect(global.fetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            signal: expect.any(AbortSignal),
          })
        );
      });
    });

    describe('Edge cases', () => {
      it('should handle empty pathname', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/', {
          store: new SegmentStore(),
        });

        expect(global.fetch).toHaveBeenCalled();
      });

      it('should handle pathname with hash', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockResolvedValue({ segments: [], updates: {} }),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await navigateToRoute('/test#section', {
          store: new SegmentStore(),
        });

        const callUrl = (global.fetch as any).mock.calls[0][0];
        // Hash should be preserved in the URL
        expect(callUrl).toContain('/test');
      });

      it('should handle malformed JSON response', async () => {
        const mockResponse = {
          ok: true,
          json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        await expect(
          navigateToRoute('/test', {
            store: new SegmentStore(),
          })
        ).rejects.toThrow('Invalid JSON');
      });
    });
  });
});
