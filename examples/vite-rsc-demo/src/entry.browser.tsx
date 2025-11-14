import { createFromReadableStream, createFromFetch, setServerCallback, encodeReply, createTemporaryReferenceSet } from '@vitejs/plugin-rsc/browser';
import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { rscStream } from 'rsc-html-stream/client';
import type { RscPayload } from './entry.rsc.js';
import { renderSegments, type ResolvedSegment } from 'rsc-router';

console.log('[Browser] Initializing...');

// ============================================================================
// Navigation Manager
// ============================================================================

interface NavigationManager {
  currentUrl: string;
  currentSegmentIds: string[];
  storedSegments: Map<string, ResolvedSegment>;
  setPayload: ((payload: { root: React.ReactNode; metadata: any }) => void) | null;
}

const navigationManager: NavigationManager = {
  currentUrl: window.location.href,
  currentSegmentIds: [],
  storedSegments: new Map(),
  setPayload: null,
};

// ============================================================================
// Server Action Callback
// ============================================================================

// Setup server action callback - React calls this when server actions are invoked
setServerCallback(async (id: string, args: any[]) => {
  console.log(`\n[Browser] >>> SERVER ACTION: ${id}`);
  console.log(`[Browser] Args:`, args);

  // 1. Create temporary references for serialization
  const temporaryReferences = createTemporaryReferenceSet();

  // 2. Build action request URL with current segments
  const url = new URL(window.location.href);
  url.searchParams.set('_rsc_action', id);
  url.searchParams.set('_rsc_segments', navigationManager.currentSegmentIds.join(','));

  // 3. Encode arguments
  const encodedBody = await encodeReply(args, { temporaryReferences });

  console.log(`[Browser] Encoded body type:`, typeof encodedBody, encodedBody instanceof FormData);
  console.log(`[Browser] Sending action request to: ${url.href}`);
  console.log(`[Browser] Current segments: ${navigationManager.currentSegmentIds.join(', ')}`);

  // 4. Send action request (don't await - pass promise to createFromFetch)
  const responsePromise = fetch(url, {
    method: 'POST',
    headers: {
      'rsc-action': id,
      'X-RSC-Router-Client-Path': navigationManager.currentUrl,
      // Note: Don't set Content-Type if using FormData - browser will set it with boundary
    },
    body: encodedBody,
  });

  // 5. Deserialize response (MUST use same temporaryReferences)
  const payload = await createFromFetch<RscPayload>(responsePromise, { temporaryReferences });

  console.log(`[Browser] Action response received:`, payload.metadata);

  // 6. Process same as partial navigation
  const { metadata } = payload;
  const { matched, diff, segments, isPartial } = metadata || {};

  if (isPartial) {
    // Store new segments
    segments?.forEach((segment: ResolvedSegment) => {
      navigationManager.storedSegments.set(segment.id, segment);
    });

    // Rebuild from matched (source of truth)
    const fullSegments = matched.map((id: string) =>
      navigationManager.storedSegments.get(id)
    ).filter(Boolean) as ResolvedSegment[];

    // HMR resilience check
    if (fullSegments.length < matched.length) {
      console.warn(`[Browser] Missing segments after action, refetching...`);
      return fetchPartialUpdate(window.location.href, []);
    }

    // Update state
    navigationManager.currentSegmentIds = matched;

    // Render
    const newTree = renderSegments(fullSegments);
    navigationManager.setPayload?.({ root: newTree, metadata });

    console.log(`[Browser] ✓ Action complete - UI updated`);
  } else {
    // Full update
    navigationManager.currentSegmentIds = matched || [];
    navigationManager.setPayload?.(payload);
  }

  // Actions don't return values (updates happen via RSC)
  return undefined;
});

console.log('[Browser] ✓ Server action callback registered');

// ============================================================================
// Fetch Partial Update
// ============================================================================

async function fetchPartialUpdate(targetUrl?: string, segmentIds?: string[]) {
  const url = targetUrl || window.location.href;
  const segments = segmentIds ?? navigationManager.currentSegmentIds;

  console.log(`\n[Browser] >>> NAVIGATION`);
  console.log(`[Browser] From: ${navigationManager.currentUrl}`);
  console.log(`[Browser] To: ${url}`);
  console.log(`[Browser] Segments to send: ${segments.join(', ')}`);

  // Build fetch URL with partial rendering params
  const fetchUrl = new URL(url);
  fetchUrl.searchParams.set('_rsc_partial', 'true');
  fetchUrl.searchParams.set('_rsc_segments', segments.join(','));

  console.log(`[Browser] Fetching: ${fetchUrl.pathname}${fetchUrl.search}`);

  // Fetch with previous URL header (don't await - pass promise to createFromFetch)
  const responsePromise = fetch(fetchUrl, {
    headers: {
      'X-RSC-Router-Client-Path': navigationManager.currentUrl,
    },
  });

  // Deserialize RSC payload
  const payload = await createFromFetch<RscPayload>(responsePromise);
  console.log(`[Browser] Received payload:`, payload.metadata);

  if (payload.metadata?.isPartial) {
    // Partial update - merge segments
    const { segments, matched, diff } = payload.metadata;
    console.log(`[Browser] Partial update - matched: ${matched?.join(', ')}`);
    console.log(`[Browser] Diff: ${diff?.join(', ')}`);

    // If diff is empty, nothing changed - skip update!
    if (!diff || diff.length === 0) {
      console.log(`[Browser] No changes - all revalidations returned false, keeping existing UI`);
      // Still update URL state
      navigationManager.currentUrl = url;
      console.log(`[Browser] ✓ Navigation complete (no re-render)\n`);
      return;
    }

    // Update stored segments with new ones
    segments?.forEach((segment: ResolvedSegment) => {
      navigationManager.storedSegments.set(segment.id, segment);
    });

    // Build full segment list by merging
    const matchedIds = matched || [];
    const fullSegments = matchedIds.map((id: string) => {
      const segment = navigationManager.storedSegments.get(id);
      if (!segment) {
        console.warn(`[Browser] Missing segment: ${id}`);
      }
      return segment;
    }).filter(Boolean) as ResolvedSegment[];

    // HMR RESILIENCE: Check if we're missing segments (React Refresh cleared state)
    // If any segments are missing, refetch with empty segment list (server sends all)
    if (fullSegments.length < matchedIds.length) {
      const missingCount = matchedIds.length - fullSegments.length;
      console.warn(`[Browser] HMR detected: Missing ${missingCount} segments in storage. Refetching all segments...`);

      // Refetch with empty segments = tell server "I have nothing, send everything"
      return fetchPartialUpdate(url, []); // Recursive call with empty segments
    }

    console.log(`[Browser] Merged segments: ${fullSegments.map(s => s.id).join(', ')}`);

    // Rebuild tree on client
    const newTree = renderSegments(fullSegments);

    // Update segment IDs
    navigationManager.currentSegmentIds = matchedIds;
    navigationManager.currentUrl = url;

    // Update UI
    navigationManager.setPayload?.({
      root: newTree,
      metadata: payload.metadata,
    });

    console.log(`[Browser] ✓ Navigation complete\n`);
  } else {
    // Full update (fallback)
    console.log(`[Browser] Full update (fallback)`);
    navigationManager.currentSegmentIds = payload.metadata?.segments?.map((s: any) => s.id) || [];
    navigationManager.currentUrl = url;

    // Store all segments (metadata segments don't have components on initial load)
    // Just track IDs for now

    navigationManager.setPayload?.({
      root: payload.root,
      metadata: payload.metadata,
    });
  }
}

// ============================================================================
// Link Interception
// ============================================================================

function shouldInterceptLink(link: HTMLAnchorElement): boolean {
  // Only intercept same-origin links
  if (link.origin !== window.location.origin) {
    return false;
  }

  // Don't intercept if it has download attribute
  if (link.hasAttribute('download')) {
    return false;
  }

  // Don't intercept if target is set
  if (link.target && link.target !== '_self') {
    return false;
  }

  // Don't intercept if modifier keys are pressed
  if (link.getAttribute('data-no-intercept') === 'true') {
    return false;
  }

  return true;
}

function setupLinkInterception() {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const link = target.closest('a');

    if (!link || !shouldInterceptLink(link)) {
      return;
    }

    e.preventDefault();
    const href = link.href;

    // Update URL
    window.history.pushState({}, '', href);

    // Fetch partial update
    fetchPartialUpdate(href);
  });

  console.log('[Browser] ✓ Link interception enabled');
}

// ============================================================================
// Root Component
// ============================================================================

function BrowserRoot({ initialPayload }: { initialPayload: RscPayload }) {
  const [payload, setPayload] = React.useState(initialPayload);

  React.useEffect(() => {
    // Register setPayload callback
    navigationManager.setPayload = setPayload;

    // Setup link interception
    setupLinkInterception();

    // Setup popstate listener
    window.addEventListener('popstate', () => {
      fetchPartialUpdate();
    });

    console.log('[Browser] ✓ Ready for navigation');

    return () => {
      navigationManager.setPayload = null;
    };
  }, []);

  return payload.root;
}

// ============================================================================
// Initialize App
// ============================================================================

async function initializeApp() {
  console.log('[Browser] Loading initial payload...');

  // Get RSC stream from SSR-injected __FLIGHT_DATA__
  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

  console.log('[Browser] Initial payload:', initialPayload.metadata);

  // Initialize navigation manager
  navigationManager.currentUrl = window.location.href;
  navigationManager.currentSegmentIds = initialPayload.metadata?.segments?.map((s: any) => s.id) || [];

  // Store initial segments
  initialPayload.metadata?.segments?.forEach((segment: any) => {
    // For initial load, segments in metadata don't have components
    // We'll need to track the actual rendered segments differently
    // For now, just store the IDs
  });

  console.log('[Browser] Initial segments:', navigationManager.currentSegmentIds.join(', '));

  // Hydrate
  const root = document.getElementById('root') || document;
  hydrateRoot(
    root,
    <React.StrictMode>
      <BrowserRoot initialPayload={initialPayload} />
    </React.StrictMode>
  );

  console.log('[Browser] ✓ Hydrated\n');
}

// Start the app
initializeApp().catch((error) => {
  console.error('[Browser] Initialization error:', error);
});
