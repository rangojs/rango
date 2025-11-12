/**
 * Example: Client-Side Navigation
 *
 * Demonstrates:
 * - Segment store initialization
 * - SPA navigation with _has parameter
 * - Payload processing and reconciliation
 * - Tree reconstruction and rendering
 */

'use client';

import {
  SegmentStore,
  navigateToRoute,
  processPayload,
  reconstructTreeFromSegments,
} from '../../src/client';
import type { Segment } from '../../src/segment-system';
import { createRoot } from 'react-dom/client';

// ============================================================================
// GLOBAL STORE INSTANCE
// ============================================================================

let globalStore: SegmentStore;

/**
 * Initialize segment store with SSR segments
 */
export function initializeStore(initialSegments: Segment[]) {
  globalStore = new SegmentStore(initialSegments);
  return globalStore;
}

/**
 * Get the global segment store
 */
export function getStore(): SegmentStore {
  if (!globalStore) {
    globalStore = new SegmentStore();
  }
  return globalStore;
}

// ============================================================================
// NAVIGATION
// ============================================================================

/**
 * Navigate to a new route with partial rendering
 *
 * This function demonstrates the complete client-side navigation flow:
 * 1. Fetch from server with _has parameter (current segments)
 * 2. Process server response (reconcile + update store)
 * 3. Reconstruct React tree from updated segments
 * 4. Render the new tree
 * 5. Update browser URL
 */
export async function navigate(pathname: string) {
  const store = getStore();

  try {
    console.log(`Navigating to: ${pathname}`);
    console.log(`Current segments: ${store.getIds().join(', ')}`);

    // 1. Fetch with _has parameter
    // Server will compute differential based on what we have
    const payload = await navigateToRoute(pathname, { store });

    console.log(`Server segments: ${payload.segments.join(', ')}`);
    console.log(`Updates received: ${Object.keys(payload.updates).join(', ')}`);

    // 2. Process payload
    // - Reconciles store (removes segments not in server list)
    // - Updates segments from payload.updates
    processPayload(payload, store);

    console.log(`After reconciliation: ${store.getIds().join(', ')}`);

    // 3. Reconstruct React tree from segments
    const tree = reconstructTreeFromSegments(store.getAll());

    // 4. Render the tree
    const root = document.getElementById('root');
    if (root) {
      createRoot(root).render(tree);
    }

    // 5. Update browser URL
    window.history.pushState({}, '', pathname);

    console.log('Navigation complete!');
  } catch (error) {
    console.error('Navigation failed:', error);
    // Show error UI
  }
}

// ============================================================================
// LINK COMPONENT
// ============================================================================

/**
 * Link component that uses client-side navigation
 */
export function Link({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(href);
  };

  return (
    <a href={href} onClick={handleClick}>
      {children}
    </a>
  );
}

// ============================================================================
// HYDRATION
// ============================================================================

/**
 * Hydrate the application on page load
 *
 * Initializes the segment store with SSR-rendered segments
 * and sets up navigation handlers.
 */
export function hydrate(initialSegments: Segment[]) {
  console.log('Hydrating with segments:', initialSegments.map((s) => s.id));

  // Initialize store with SSR segments
  initializeStore(initialSegments);

  // Set up popstate handler for back/forward
  window.addEventListener('popstate', () => {
    navigate(window.location.pathname);
  });

  console.log('Hydration complete!');
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

/*

// In your app entry point:
import { hydrate, navigate, Link } from './client';

// 1. Hydrate on page load
const initialSegments = window.__INITIAL_SEGMENTS__;
hydrate(initialSegments);

// 2. Use Link component for navigation
function App() {
  return (
    <div>
      <nav>
        <Link href="/">Home</Link>
        <Link href="/blog">Blog</Link>
        <Link href="/dashboard">Dashboard</Link>
      </nav>
    </div>
  );
}

// 3. Or navigate programmatically
navigate('/blog/hello-world');

*/
