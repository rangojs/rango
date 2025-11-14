import { createFromReadableStream, createFromFetch } from '@vitejs/plugin-rsc/browser';
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
// Fetch Partial Update
// ============================================================================

async function fetchPartialUpdate(targetUrl?: string) {
  const url = targetUrl || window.location.href;

  console.log(`\n[Browser] >>> NAVIGATION`);
  console.log(`[Browser] From: ${navigationManager.currentUrl}`);
  console.log(`[Browser] To: ${url}`);
  console.log(`[Browser] Current segments: ${navigationManager.currentSegmentIds.join(', ')}`);

  // Build fetch URL with partial rendering params
  const fetchUrl = new URL(url);
  fetchUrl.searchParams.set('_rsc_partial', 'true');
  fetchUrl.searchParams.set('_rsc_segments', navigationManager.currentSegmentIds.join(','));

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
