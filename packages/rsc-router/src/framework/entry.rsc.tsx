/**
 * RSC Framework Entry Point - Server
 *
 * Handles RSC stream generation with full and partial rendering support.
 * This entry point runs in the 'rsc' environment with react-server condition.
 *
 * Responsibilities:
 * - RSC stream serialization (React VDOM → RSC stream)
 * - Server function handling
 * - Full vs partial rendering logic
 * - Segment metadata generation
 */

import {
  renderToReadableStream,
  createTemporaryReferenceSet,
  decodeReply,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from '@vitejs/plugin-rsc/rsc';
import type { ReactFormState } from 'react-dom/client';
import type { RscPayload, SegmentMetadata } from './types';
import { toSegmentMetadata } from './types';
import type { RSCRouter } from '../create-router';
import { Storage } from './storage';

// Partial rendering parameters
const PARTIAL_PARAM = '_rsc_partial';
const PREV_PATH_PARAM = '_rsc_prev';
const RSC_ACTION_HEADER = 'x-rsc-action';

/**
 * Create default RSC request handler
 *
 * This function creates a request handler for your RSC application.
 * Users import their router and pass it to this function.
 *
 * @param router - Configured RSCRouter instance
 * @returns Request handler for RSC environment
 *
 * @example
 * ```typescript
 * // In your entry.rsc.tsx
 * import { createRSCRouter, route } from 'rsc-router';
 * import { createRSCHandler } from 'rsc-router/framework';
 *
 * const router = createRSCRouter();
 * router.route(routes).map(handlers);
 *
 * export default createRSCHandler(router);
 * ```
 */
export function createRSCHandler(router: RSCRouter) {
  return async function handler(request: Request): Promise<Response> {
    const streams: ReadableStream<Uint8Array>[] = [];
    return await Storage.run(streams, () => _handler(request, router));
  };
}

async function _handler(
  request: Request,
  router: RSCRouter
): Promise<Response> {
  // ========================================================================
  // 1. HANDLE SERVER ACTIONS
  // ========================================================================

  const isAction = request.method === 'POST';
  let returnValue: unknown | undefined;
  let formState: ReactFormState | undefined;
  let temporaryReferences: unknown | undefined;

  if (isAction) {
    // Server action called via ReactClient.setServerCallback
    const actionId = request.headers.get(RSC_ACTION_HEADER);

    if (actionId) {
      const contentType = request.headers.get('content-type');
      const body = contentType?.startsWith('multipart/form-data')
        ? await request.formData()
        : await request.text();

      temporaryReferences = createTemporaryReferenceSet();
      const args = await decodeReply(body, { temporaryReferences });
      const action = await loadServerAction(actionId);
      returnValue = await action.apply(null, args);
    } else {
      // Progressive enhancement - form submission before hydration
      const formData = await request.formData();
      const decodedAction = await decodeAction(formData);
      const result = await decodedAction();
      formState = await decodeFormState(result, formData);
    }
  }

  // ========================================================================
  // 2. DETERMINE RENDER TYPE (Full vs Partial)
  // ========================================================================

  const url = new URL(request.url);
  const isPartialRequest = url.searchParams.has(PARTIAL_PARAM);
  const previousPathname = url.searchParams.get(PREV_PATH_PARAM);

  console.log(`\n[RSC] ${'='.repeat(60)}`);
  console.log(`[RSC] Request: ${request.method} ${url.pathname}${url.search}`);
  console.log(`[RSC] Partial: ${isPartialRequest}`);
  console.log(`[RSC] Previous: ${previousPathname || 'N/A'}`);

  let metadata: RscPayload['metadata'];

  // ========================================================================
  // 3. PARTIAL RENDERING
  // ========================================================================

  if (isPartialRequest && previousPathname) {
    console.log(`[RSC] >>> Attempting PARTIAL render`);

    const partialResult = await router.matchPartial(request, previousPathname);

    console.log(
      `[RSC] matchPartial result:`,
      partialResult ? `${partialResult.segments.length} segments` : 'null'
    );

    if (partialResult && partialResult.segments.length > 0) {
      // Partial rendering successful
      const { segments, startIndex, preservedLayouts } = partialResult;

      console.log(`[RSC] ✓ Partial render successful`);
      console.log(`[RSC]   Start index: ${startIndex}`);
      console.log(
        `[RSC]   Preserved layouts: ${preservedLayouts.join(', ') || 'none'}`
      );
      console.log(`[RSC]   Segments sent: ${segments.length}`);

      segments.forEach((seg: any) => {
        const slotInfo = seg.slot ? ` (${seg.slot})` : '';
        console.log(`[RSC]     - ${seg.id}: ${seg.type}${slotInfo}`);
      });

      // Render segments to React tree
      const { renderSegments } = await import('../segment-system');
      const component = renderSegments(segments);
      console.log('component', component);

      throw new Error('Debug stop');

      // Strip components from segments for metadata (can't serialize functions!)
      const segmentMetadata: SegmentMetadata[] =
        segments.map(toSegmentMetadata);

      metadata = {
        pathname: url.pathname,
        segments: segmentMetadata,
        startIndex,
        preservedLayouts,
        isPartial: true,
      };
    } else {
      // Partial failed, fallback to full
      console.log(`[RSC] ⚠️  Partial render failed, falling back to full`);
      const match = await router.match(request);

      if (match && (match as any).matched) {
        const { buildSegmentMap, renderSegments } = await import('rsc-router');
        const segments = buildSegmentMap({
          pathname: (match as any).context.pathname,
          params: (match as any).params,
          handlers: (match as any).handlers,
        });

        component = renderSegments(segments);

        // Strip components from segments for metadata
        const segmentMetadata: SegmentMetadata[] =
          segments.map(toSegmentMetadata);
        metadata = { pathname: url.pathname, segments: segmentMetadata };
      } else {
        component = null;
      }
    }
  }
  // ========================================================================
  // 4. FULL RENDERING
  // ========================================================================
  else {
    console.log(`[RSC] >>> Performing FULL render`);

    const match = await router.match(request);

    if (match && (match as any).matched) {
      const { buildSegmentMap, renderSegments } = await import(
        '../segment-system'
      );
      const segments = buildSegmentMap({
        pathname: (match as any).context.pathname,
        params: (match as any).params,
        handlers: (match as any).handlers,
      });

      console.log(`[RSC] ✓ Route matched`);
      console.log(`[RSC]   Segments: ${segments.length}`);
      segments.forEach((seg: any) => {
        const slotInfo = seg.slot ? ` (${seg.slot})` : '';
        console.log(`[RSC]     - ${seg.id}: ${seg.type}${slotInfo}`);
      });

      component = renderSegments(segments);

      // Strip components from segments for metadata
      const segmentMetadata: SegmentMetadata[] =
        segments.map(toSegmentMetadata);
      metadata = { pathname: url.pathname, segments: segmentMetadata };
    } else {
      console.log(`[RSC] ❌ No route matched`);
      component = null;
    }
  }

  // ========================================================================
  // 5. HANDLE 404
  // ========================================================================

  if (!component) {
    console.log(`[RSC] Rendering 404`);
    component = (
      <html>
        <body>
          <h1>404 - Not Found</h1>
          <p>The page {url.pathname} was not found.</p>
          <a href="/">Go home</a>
        </body>
      </html>
    );
    metadata = { pathname: url.pathname, segments: [] };
  }

  // ========================================================================
  // 6. CREATE RSC PAYLOAD
  // ========================================================================

  const rscPayload: RscPayload = {
    root: component,
    formState,
    returnValue,
    metadata,
  };

  console.log(`[RSC] Payload metadata:`, metadata);
  console.log(`[RSC] ${'='.repeat(60)}\n`);

  // ========================================================================
  // 7. SERIALIZE TO RSC STREAM
  // ========================================================================

  const rscOptions = { temporaryReferences };
  const rscStream = renderToReadableStream<RscPayload>(rscPayload, rscOptions);

  // Check if client wants RSC stream or HTML
  const isRscRequest =
    (!request.headers.get('accept')?.includes('text/html') &&
      !url.searchParams.has('__html')) ||
    url.searchParams.has('__rsc');

  if (isRscRequest) {
    // Return RSC stream directly
    return new Response(rscStream, {
      headers: {
        'content-type': 'text/x-component;charset=utf-8',
        vary: 'accept',
      },
    });
  }

  // ========================================================================
  // 8. DELEGATE TO SSR FOR HTML
  // ========================================================================

  // Load SSR entry module and render HTML
  const ssrEntryModule = await import.meta.viteRsc.loadModule<
    typeof import('./entry.ssr')
  >('ssr', 'index');

  const htmlStream = await ssrEntryModule.renderHTML(
    rscStream,
    {
      formState,
      debugNojs: url.searchParams.has('__nojs'),
    },
    Storage.getStore()
  );

  // Return HTML stream
  return new Response(htmlStream, {
    headers: {
      'Content-type': 'text/html',
      vary: 'accept',
    },
  });
}

// HMR support
if (import.meta.hot) {
  import.meta.hot.accept();
}
