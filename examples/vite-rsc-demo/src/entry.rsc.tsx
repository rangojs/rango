import { renderToReadableStream } from '@vitejs/plugin-rsc/rsc';
import { router } from './router.js';
import { renderSegments } from 'rsc-router';

/**
 * RSC Payload Schema
 */
export type RscPayload = {
  root: React.ReactNode;
  metadata?: {
    pathname: string;
    segments: any[];
    isPartial?: boolean;
    matched?: string[];
    diff?: string[];
  };
};

/**
 * Main entry point - handles RSC requests
 */
export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const isPartial = url.searchParams.has('_rsc_partial');

  console.log(`\n[RSC] ${request.method} ${url.pathname}${url.search}`);
  console.log(`[RSC] Partial: ${isPartial}`);

  let payload: RscPayload;

  try {
    if (isPartial) {
      // Partial render (navigation)
      console.log(`[RSC] >>> PARTIAL RENDER`);
      const result = await router.matchPartial(request, {});

      if (!result) {
        // Fall back to full render
        console.log(`[RSC] Partial match failed, falling back to full`);
        const match = await router.match(request, {});
        const root = renderSegments(match.segments);

        payload = {
          root,
          metadata: {
            pathname: url.pathname,
            segments: match.segments.map(s => ({ id: s.id, type: s.type, index: s.index, params: s.params })),
            matched: match.matched,
            diff: match.diff,
          },
        };
      } else {
        payload = {
          root: null,
          metadata: {
            pathname: url.pathname,
            segments: result.segments,
            isPartial: true,
            matched: result.matched,
            diff: result.diff,
          },
        };
      }
    } else {
      // Full render (initial page load)
      console.log(`[RSC] >>> FULL RENDER`);
      const match = await router.match(request, {});
      const root = renderSegments(match.segments);

      payload = {
        root,
        metadata: {
          pathname: url.pathname,
          segments: match.segments.map(s => ({ id: s.id, type: s.type, index: s.index, params: s.params })),
          matched: match.matched,
          diff: match.diff,
        },
      };
    }

    console.log(`[RSC] ✓ Payload ready`);
    console.log(`[RSC] Segments:`, payload.metadata?.segments?.map(s => s.id).join(', '));

    // Serialize to RSC stream
    const rscStream = renderToReadableStream<RscPayload>(payload);

    // Determine if this is an RSC request or HTML request
    const isRscRequest =
      (!request.headers.get('accept')?.includes('text/html') &&
        !url.searchParams.has('__html')) ||
      url.searchParams.has('__rsc');

    if (isRscRequest) {
      // Return RSC stream for client navigation
      console.log(`[RSC] → Returning RSC stream`);
      return new Response(rscStream, {
        headers: {
          'content-type': 'text/x-component;charset=utf-8',
          vary: 'accept',
        },
      });
    }

    // Delegate to SSR for HTML response (document requests)
    console.log(`[RSC] → Delegating to SSR for HTML`);
    const ssrEntryModule = await import.meta.viteRsc.loadModule<
      typeof import('./entry.ssr.js')
    >('ssr', 'index');

    const htmlStream = await ssrEntryModule.renderHTML(rscStream);

    return new Response(htmlStream, {
      headers: {
        'content-type': 'text/html;charset=utf-8',
      },
    });
  } catch (error) {
    console.error(`[RSC] Error:`, error);
    throw error;
  }
}
