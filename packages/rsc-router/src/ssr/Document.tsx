import type { ReactNode } from "react";

/**
 * Props for the Document component
 */
export interface DocumentProps {
  children: ReactNode;
}

/**
 * Default bare Document component for SSR
 * Provides minimal HTML structure required for React hydration
 *
 * Users can import and extend this, or provide their own Document
 * via the router's document option
 */
export function Document({ children }: DocumentProps): ReactNode {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}

/**
 * Passthrough Document for when RSC rootLayout handles the HTML shell
 *
 * Use this when your RSC root layout component renders <html>, <head>, <body>
 * This Document simply passes children through without wrapping
 *
 * @example
 * ```typescript
 * // entry.ssr.tsx - when using rootLayout in RSC
 * import { createSSRHandler, PassthroughDocument } from "rsc-router/ssr";
 *
 * export const { renderHTML } = createSSRHandler({
 *   deps: { createFromReadableStream },
 *   renderToReadableStream,
 *   injectRSCPayload,
 *   Document: PassthroughDocument, // RSC handles <html> shell
 * });
 * ```
 */
export function PassthroughDocument({ children }: DocumentProps): ReactNode {
  return children;
}
