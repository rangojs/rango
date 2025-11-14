import { renderToReadableStream, decodeReply, createTemporaryReferenceSet, decodeAction } from '@vitejs/plugin-rsc/rsc';
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
  const isAction = request.headers.has('rsc-action') || url.searchParams.has('_rsc_action');
  const actionId = request.headers.get('rsc-action') || url.searchParams.get('_rsc_action');

  console.log(`\n[RSC] ${request.method} ${url.pathname}${url.search}`);
  console.log(`[RSC] Partial: ${isPartial}`);
  console.log(`[RSC] Action: ${isAction ? actionId : 'none'}`);

  let payload: RscPayload;

  try {
    // ============================================================================
    // SERVER ACTION EXECUTION
    // ============================================================================
    if (isAction && actionId) {
      console.log(`[RSC] >>> ACTION REQUEST: ${actionId}`);

      // 1. Create temporary references for decoding arguments
      const temporaryReferences = createTemporaryReferenceSet();

      // 2. Decode action arguments from request body
      // decodeReply can handle FormData or text body automatically
      const contentType = request.headers.get('content-type') || '';
      console.log(`[RSC] Content-Type: ${contentType}`);

      let args: any[] = [];
      let actionFormData: FormData | undefined;

      try {
        // decodeReply accepts FormData or text - get the appropriate body
        const body = contentType.includes('multipart/form-data')
          ? await request.formData()
          : await request.text();

        console.log(`[RSC] Body type:`, body instanceof FormData ? 'FormData' : 'text');

        // Store FormData for revalidation context
        if (body instanceof FormData) {
          actionFormData = body;
        }

        if ((body instanceof FormData && body.entries().next().done === false) ||
            (typeof body === 'string' && body.length > 0)) {
          args = await decodeReply(body, { temporaryReferences });
          console.log(`[RSC] Action args decoded:`, args);
        } else {
          console.log(`[RSC] Empty body, using empty args`);
        }
      } catch (error) {
        console.error(`[RSC] Failed to decode args:`, error);
        throw new Error(`Failed to decode action arguments: ${error}`);
      }

      // 3. Load and execute the server action
      // Parse action ID: "/src/actions/shop.actions.ts#addToCart"
      const [filePath, exportName] = actionId.split('#');
      console.log(`[RSC] Loading action from: ${filePath}, export: ${exportName}`);

      let actionResult: any;
      try {
        // Dynamically import the action module
        const actionModule = await import(/* @vite-ignore */ filePath);
        const action = actionModule[exportName];

        if (!action || typeof action !== 'function') {
          throw new Error(`Action ${exportName} not found in ${filePath}`);
        }

        console.log(`[RSC] Executing action with args:`, args.slice(0, 2)); // Only use first 2 args

        // Execute the action (ignore the FormData at index 2)
        actionResult = await action(...args.slice(0, 2));

        console.log(`[RSC] Action executed successfully, result:`, actionResult);
      } catch (error) {
        console.error(`[RSC] Action execution error:`, error);
        throw error;
      }

      // 5. Revalidate to determine which segments need updating
      console.log(`[RSC] Running revalidation after action...`);

      // Build action context for revalidation functions
      const actionContext = {
        actionId,
        actionUrl: new URL(request.url),
        actionResult,
        formData: actionFormData,
      };

      console.log(`[RSC] Action context for revalidation:`, {
        actionId: actionContext.actionId,
        actionUrl: actionContext.actionUrl.href,
        hasFormData: !!actionContext.formData,
        hasResult: actionContext.actionResult !== undefined,
      });

      const matchResult = await router.matchPartial(request, {}, actionContext);

      if (!matchResult) {
        // Fall back to full render if partial match fails
        console.log(`[RSC] Partial match failed after action, falling back to full render`);
        const fullMatch = await router.match(request, {});
        const root = renderSegments(fullMatch.segments);

        payload = {
          root,
          metadata: {
            pathname: url.pathname,
            segments: fullMatch.segments.map(s => ({ id: s.id, type: s.type, index: s.index, params: s.params })),
            matched: fullMatch.matched,
            diff: fullMatch.diff,
          },
        };

        const rscStream = renderToReadableStream<RscPayload>(payload, { temporaryReferences });

        console.log(`[RSC] Action complete - returning full render`);
        return new Response(rscStream, {
          headers: {
            'content-type': 'text/x-component;charset=utf-8',
          },
        });
      }

      // 6. Return updated segments (same format as partial navigation)
      const root = renderSegments(matchResult.segments);

      payload = {
        root: null,
        metadata: {
          pathname: url.pathname,
          segments: matchResult.segments,
          isPartial: true,
          matched: matchResult.matched,
          diff: matchResult.diff,
        },
      };

      const rscStream = renderToReadableStream<RscPayload>(payload, { temporaryReferences });

      console.log(`[RSC] Action complete - returning updated segments`);
      console.log(`[RSC] Matched: ${matchResult.matched.join(', ')}`);
      console.log(`[RSC] Diff: ${matchResult.diff.join(', ')}`);

      return new Response(rscStream, {
        headers: {
          'content-type': 'text/x-component;charset=utf-8',
        },
      });
    }

    // ============================================================================
    // REGULAR RSC RENDERING (Navigation)
    // ============================================================================
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
    // Check if middleware/handler returned Response (redirect, auth, etc.)
    if (error instanceof Response) {
      console.log(`[RSC] Middleware/handler returned Response - returning directly`);
      return error;
    }

    // Actual error - log and re-throw
    console.error(`[RSC] Error:`, error);
    throw error;
  }
}
