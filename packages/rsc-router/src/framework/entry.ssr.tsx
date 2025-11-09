/**
 * RSC Framework Entry Point - SSR
 *
 * Handles server-side HTML rendering from RSC streams.
 * This entry point runs in the 'ssr' environment.
 *
 * Responsibilities:
 * - RSC stream deserialization (RSC stream → React VDOM)
 * - Traditional SSR (React VDOM → HTML string/stream)
 * - RSC payload injection into HTML
 * - Bootstrap script injection for hydration
 */

import { createFromReadableStream } from '@vitejs/plugin-rsc/ssr';
import React from 'react';
import type { ReactFormState } from 'react-dom/client';
import { renderToReadableStream } from 'react-dom/server.edge';
import { injectRSCPayload } from 'rsc-html-stream/server';
import type { RscPayload } from './types';

/**
 * Render HTML from RSC stream
 *
 * Takes an RSC stream and renders it to an HTML stream with:
 * - SSR rendering of React components
 * - RSC payload injection for client hydration
 * - Bootstrap scripts for client-side code
 *
 * @param rscStream - RSC stream from entry.rsc.tsx
 * @param options - Rendering options
 * @returns HTML stream ready to send to browser
 *
 * @example
 * ```typescript
 * // In entry.rsc.tsx
 * const rscStream = renderToReadableStream(rscPayload);
 * const htmlStream = await renderHTML(rscStream, { formState });
 * return new Response(htmlStream);
 * ```
 */
export async function renderHTML(
  rscStream: ReadableStream<Uint8Array>,
  options: {
    formState?: ReactFormState;
    nonce?: string;
    debugNojs?: boolean;
  } = {}
): Promise<ReadableStream<Uint8Array>> {
  console.log('[SSR] Rendering HTML from RSC stream...');

  // ========================================================================
  // 1. TEE RSC STREAM
  // ========================================================================

  // Duplicate RSC stream into two:
  // - rscStream1: For SSR (ReactClient.createFromReadableStream)
  // - rscStream2: For browser hydration payload injection
  const [rscStream1, rscStream2] = rscStream.tee();

  // ========================================================================
  // 2. DESERIALIZE RSC TO REACT VDOM
  // ========================================================================

  // deserialize RSC stream back to React VDOM
  let payload: Promise<RscPayload> | undefined;
  function SsrRoot() {
    // deserialization needs to be kicked off inside ReactDOMServer context
    // for ReactDomServer preinit/preloading to work
    payload ??= createFromReadableStream<RscPayload>(rscStream1);
    return <FixSsrThenable>{React.use(payload).root}</FixSsrThenable>;
  }
  /**
   * Fix component for SSR thenable handling
   */
  function FixSsrThenable(props: React.PropsWithChildren) {
    return props.children;
  }

  // ========================================================================
  // 3. RENDER TO HTML STREAM
  // ========================================================================

  const bootstrapScriptContent =
    await import.meta.viteRsc.loadBootstrapScriptContent('index');

  const htmlStream = await renderToReadableStream(<SsrRoot />, {
    bootstrapScriptContent: options.debugNojs
      ? undefined
      : bootstrapScriptContent,
    nonce: options.nonce,
    formState: options.formState,
  });

  console.log('[SSR] ✓ HTML stream created');

  // ========================================================================
  // 4. INJECT RSC PAYLOAD
  // ========================================================================

  let responseStream: ReadableStream<Uint8Array> = htmlStream;

  if (!options.debugNojs) {
    // Inject RSC payload into HTML as <script>...FLIGHT_DATA...</script>
    // Uses rsc-html-stream by @devongovett
    responseStream = responseStream.pipeThrough(
      injectRSCPayload(rscStream2, {
        nonce: options.nonce,
      })
    );

    console.log('[SSR] ✓ RSC payload injected into HTML');
  }

  console.log('[SSR] Rendering complete\n');

  return responseStream;
}
