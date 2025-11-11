import {
  renderToReadableStream,
  createTemporaryReferenceSet,
  decodeReply,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from "@vitejs/plugin-rsc/rsc";
import type { ReactFormState } from "react-dom/client";
import { router } from "../routes.tsx";
import { Storage } from "./entry.storage.ts";
import type { Segment } from "./entry.browser.tsx";
import type { ResolvedSegment } from "rsc-router";
import { renderSegments } from "rsc-router";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * RSC Payload Schema
 *
 * This is the data structure that gets serialized into RSC stream
 * on the server and deserialized on SSR/client environments.
 */
export type RscPayload = {
  // Root component to render
  root: React.ReactNode;

  // Server action results (for non-progressive enhancement)
  returnValue?: unknown;

  // Server action form state (for progressive enhancement)
  formState?: ReactFormState;

  // Metadata for partial/differential rendering
  metadata?: {
    pathname: string;
    segments: Segment[]; // Complete segment list for this route
    isPartial?: boolean; // Indicates partial vs full response
    matched?: string[]; // Matched segments for this route
    diff?: string[]; // Differential segments for partial updates
  };
};

// ============================================================================
// Differential Rendering Logic
// ============================================================================

/**
 * Determines which segments need to be sent to the client based on what they already have.
 * Layouts are skipped if unchanged, routes are always sent (they represent different pages).
 */
function computeDifferentialUpdate(
  targetSegments: Segment[],
  clientSegmentIds: string[]
): Segment[] {
  console.log(`[Entry.RSC] >>> Computing DIFFERENTIAL`);

  const clientHas = new Set(clientSegmentIds);
  const segmentsToSend: Segment[] = [];

  for (const segment of targetSegments) {
    const clientHasSegment = clientHas.has(segment.id);

    if (!clientHasSegment) {
      // Client doesn't have this segment - must send it
      segmentsToSend.push(segment);
      console.log(`[Entry.RSC]   ${segment.id}: NEW - sending`);
    } else if (segment.id.startsWith("R")) {
      // Route segments always update (different page/params)
      segmentsToSend.push(segment);
      console.log(`[Entry.RSC]   ${segment.id}: UPDATE - sending`);
    } else {
      // Layout unchanged - skip sending
      console.log(`[Entry.RSC]   ${segment.id}: UNCHANGED - skipping`);
    }
  }

  console.log(
    `[Entry.RSC] ✓ Sending ${segmentsToSend.length}/${targetSegments.length} segments`
  );

  return segmentsToSend;
}

// ============================================================================
// Server Action Handling
// ============================================================================

/**
 * Handles POST requests for server actions (form submissions and RPC calls).
 */
async function handleServerAction(request: Request): Promise<{
  returnValue?: unknown;
  formState?: ReactFormState;
  temporaryReferences?: unknown;
}> {
  const actionId = request.headers.get("x-rsc-action");

  if (actionId) {
    // RPC-style action call (e.g., onClick handler)
    const contentType = request.headers.get("content-type");
    const body = contentType?.startsWith("multipart/form-data")
      ? await request.formData()
      : await request.text();

    const temporaryReferences = createTemporaryReferenceSet();
    const args = await decodeReply(body, { temporaryReferences });
    const action = await loadServerAction(actionId);
    const returnValue = await action.apply(null, args);

    return { returnValue, temporaryReferences };
  } else {
    // Form action (progressive enhancement)
    const formData = await request.formData();
    const decodedAction = await decodeAction(formData);
    const result = await decodedAction();
    const formState = await decodeFormState(result, formData);

    return { formState };
  }
}

// ============================================================================
// Document Request Handler
// ============================================================================

/**
 * Handles full document requests (initial page loads, full refreshes)
 * These requests have no client state and need complete rendering.
 */
async function handleDocumentRequest(
  request: Request,
  url: URL,
  serverActionResult?: {
    returnValue?: unknown;
    formState?: ReactFormState;
    temporaryReferences?: unknown;
  }
): Promise<RscPayload> {
  console.log(`[Entry.RSC] >>> DOCUMENT REQUEST: Full render`);
  // Match the route and get all segments
  const match = await router.match(request, {});
  console.log("segments", match);

  // Handle 404s and prepare component
  const finalComponent = renderSegments(match.segments);
  console.log("finalComponent", finalComponent);

  // Build complete RSC payload
  return {
    root: finalComponent,
    returnValue: serverActionResult?.returnValue,
    formState: serverActionResult?.formState,
    metadata: {
      pathname: url.pathname,
      segments: match.segments,
      isPartial: false,
      matched: match.matched,
      diff: match.diff,
    },
  };
}

// ============================================================================
// Partial Request Handler
// ============================================================================

/**
 * Handles partial requests (client-side navigation)
 * These requests have existing client state and need differential updates.
 */
async function handlePartialRequest(
  request: Request,
  url: URL,
  clientSegmentIds: string[],
  serverActionResult?: {
    returnValue?: unknown;
    formState?: ReactFormState;
    temporaryReferences?: unknown;
  }
): Promise<RscPayload> {
  console.log(`[Entry.RSC] >>> PARTIAL REQUEST: Differential render`);
  console.log(`[Entry.RSC] >>> URL: ${url.href}`);
  console.log(`[Entry.RSC] Client segments: ${clientSegmentIds.join(", ")}`);

  // Match the route and get target segments
  const match = await router.matchPartial(request, clientSegmentIds, {});
  console.log("partial segments", match);
  // Build partial RSC payload
  return {
    root: null,
    returnValue: serverActionResult?.returnValue,
    formState: serverActionResult?.formState,
    metadata: {
      pathname: url.pathname,
      segments: match.segments,
      isPartial: true,
      matched: match.matched,
      diff: match.diff,
    },
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Main request handler with Storage context
 */
export default async function handler(request: Request): Promise<Response> {
  const streams = [];
  return await Storage.run(streams, () => processRequest(request));
}

/**
 * Core request processing logic
 */
async function processRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // ==================== Request Logging ====================
  console.log(
    `\n[Entry.RSC] ==================== REQUEST ====================`
  );
  console.log(`[Entry.RSC] URL: ${url.pathname}${url.search}`);
  console.log(`[Entry.RSC] Method: ${request.method}`);

  // ==================== Server Actions ====================
  let serverActionResult;
  if (request.method === "POST") {
    serverActionResult = await handleServerAction(request);
  }

  // ==================== Client State Detection ====================
  const hasParam = url.searchParams.get("_has");
  const clientSegmentIds = hasParam ? hasParam.split(",") : [];
  console.log(
    `[Entry.RSC] Client has: ${clientSegmentIds.join(", ") || "none"}`
  );

  // ==================== Route to Appropriate Handler ====================
  const rscPayload =
    clientSegmentIds.length > 0
      ? await handlePartialRequest(
          request,
          url,
          clientSegmentIds,
          serverActionResult
        )
      : await handleDocumentRequest(request, url, serverActionResult);

  console.log(`[Entry.RSC] RSC Payload metadata:`, rscPayload.metadata);
  console.log(
    `[Entry.RSC] ==================== END REQUEST ====================\n`
  );

  // ==================== Serialize to RSC Stream ====================
  const rscOptions = {
    temporaryReferences: serverActionResult?.temporaryReferences,
  };
  const rscStream = renderToReadableStream<RscPayload>(rscPayload, rscOptions);

  // ==================== Determine Response Type ====================
  const isRscRequest =
    (!request.headers.get("accept")?.includes("text/html") &&
      !url.searchParams.has("__html")) ||
    url.searchParams.has("__rsc");

  if (isRscRequest) {
    // Return RSC stream directly for React consumption
    return new Response(rscStream, {
      headers: {
        "content-type": "text/x-component;charset=utf-8",
        vary: "accept",
      },
    });
  }

  // ==================== SSR for HTML Responses ====================
  const ssrEntryModule = await import.meta.viteRsc.loadModule<
    typeof import("./entry.ssr.tsx")
  >("ssr", "index");

  const htmlStream = await ssrEntryModule.renderHTML(
    rscStream,
    {
      formState: rscPayload.formState,
      debugNojs: url.searchParams.has("__nojs"),
    },
    Storage.getStore()
  );

  return new Response(htmlStream, {
    headers: {
      "Content-type": "text/html",
      vary: "accept",
    },
  });
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
