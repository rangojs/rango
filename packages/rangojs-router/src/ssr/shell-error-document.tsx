/**
 * What renderHTML answers when React's server render fails its shell: an
 * error with no `<Suspense>` above it (a loader read, a component that throws
 * only on the server). Fizz runs no error boundaries, so renderToReadableStream
 * rejects; rethrown, the host would answer its own raw 500 (a stack with
 * server paths in production).
 *
 * The answer, in order:
 * - a loader `redirect()` with no state: a real 3xx (nothing has been sent);
 * - the payload decoded and the tree built: a recovery document carrying the
 *   same Flight payload, which the browser entry renders with createRoot
 *   (`data-rango-ssr-error`), so the router's client boundaries run as on a
 *   client navigation to the URL (the Next.js `__next_error__` design);
 * - otherwise: a static document with no scripts and nothing from the error.
 */
import React from "react";
import { isDataNotFoundError } from "../errors.js";
import { loaderRedirectOf } from "../decode-loader-results.js";
import { ThemeScript } from "../theme/ThemeScript.js";
import type { ResolvedThemeConfig } from "../theme/types.js";
import type { SSRDependencies } from "./index.js";

/**
 * Read by the browser entry (vite/plugins/virtual-entries.ts): render the
 * document, do not hydrate it.
 */
const SSR_ERROR_ATTRIBUTE = "data-rango-ssr-error";

/** What renderHTML answered a shell error with. */
export interface ShellErrorAnswer {
  body: ReadableStream<Uint8Array>;
  status: number;
  location?: string;
}

/**
 * What a recovery document needs. Absent when the payload did not decode or
 * the tree build rejected: the browser builds the same tree from the same
 * payload and would reject the same way.
 */
export interface ShellErrorRecovery {
  bootstrap: { bootstrapScriptContent?: string; bootstrapModules?: string[] };
  themeConfig: ResolvedThemeConfig | null;
}

type ShellErrorRenderDeps = Pick<
  SSRDependencies,
  "renderToReadableStream" | "injectRSCPayload"
>;

const HEADINGS: Record<number, string> = {
  200: "Redirecting",
  404: "Not Found",
  500: "Internal Server Error",
};

function staticErrorDocument(status: number): ReadableStream<Uint8Array> {
  return new Response(
    `<!DOCTYPE html><html ${SSR_ERROR_ATTRIBUTE}=""><head><meta charset="utf-8"/>` +
      `<title>${HEADINGS[status]}</title></head><body><h1>${HEADINGS[status]}</h1></body></html>`,
  ).body!;
}

/**
 * The recovery document: the bootstrap scripts, the untouched second branch
 * of the Flight tee, and the heading only in <noscript>, so a JavaScript
 * visitor sees the client render's boundary without a flash of it. The theme
 * script runs here, as the document's own does on a hydrated page: the client
 * render inserts the root layout's inline scripts without running them.
 */
async function renderRecoveryDocument(
  deps: ShellErrorRenderDeps,
  recovery: ShellErrorRecovery,
  flight: ReadableStream<Uint8Array>,
  status: number,
  nonce: string | undefined,
): Promise<ReadableStream<Uint8Array>> {
  const html = await deps.renderToReadableStream(
    <html {...{ [SSR_ERROR_ATTRIBUTE]: "" }}>
      <head>
        <meta charSet="utf-8" />
        {recovery.themeConfig && (
          <ThemeScript config={recovery.themeConfig} nonce={nonce} />
        )}
      </head>
      <body>
        <noscript>
          <h1>{HEADINGS[status]}</h1>
        </noscript>
      </body>
    </html>,
    { ...recovery.bootstrap, nonce },
  );
  return html.pipeThrough(deps.injectRSCPayload(flight, { nonce }));
}

/** Answer a shell error; see the module comment for the order. */
export async function answerShellError(
  deps: ShellErrorRenderDeps,
  error: unknown,
  recovery: ShellErrorRecovery | undefined,
  flight: ReadableStream<Uint8Array> | undefined,
  nonce: string | undefined,
): Promise<ShellErrorAnswer> {
  // A redirect with state keeps the recovery document: the state rides the
  // history entry the client replace writes, which a 3xx cannot. Without
  // this branch every loader redirect takes the client replace.
  const redirect = loaderRedirectOf(error);
  if (redirect && redirect.state === undefined) {
    flight?.cancel().catch(() => {});
    return {
      body: new Response("").body!,
      status: redirect.status ?? 302,
      location: redirect.to,
    };
  }
  // A redirect with state answers 200 like the same redirect inside a
  // <Suspense>: the document, then the client replace.
  const status = redirect ? 200 : isDataNotFoundError(error) ? 404 : 500;
  if (recovery && flight) {
    try {
      return {
        body: await renderRecoveryDocument(
          deps,
          recovery,
          flight,
          status,
          nonce,
        ),
        status,
      };
    } catch {
      // The static document below.
    }
  }
  flight?.cancel().catch(() => {});
  const failed = redirect ? 500 : status;
  return { body: staticErrorDocument(failed), status: failed };
}
