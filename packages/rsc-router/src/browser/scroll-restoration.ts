/**
 * Scroll Restoration Module
 *
 * Provides scroll position persistence across navigations, following React Router v7 patterns:
 * - Saves scroll positions to sessionStorage keyed by unique history entry key
 * - Restores scroll on back/forward navigation
 * - Scrolls to top on new navigation (unless scroll: false)
 * - Supports hash link scrolling
 */

const SCROLL_STORAGE_KEY = "rsc-router-scroll-positions";

/**
 * Interval for polling scroll restoration during streaming (ms).
 * If content is still loading and we can't scroll to saved position,
 * keep trying at this interval.
 */
const SCROLL_POLL_INTERVAL_MS = 50;

/**
 * Maximum time to keep polling for scroll restoration (ms).
 * After this timeout, stop trying even if streaming continues.
 */
const SCROLL_POLL_TIMEOUT_MS = 5000;

/**
 * In-memory cache of scroll positions.
 * Synced with sessionStorage on pagehide.
 */
let savedScrollPositions: Record<string, number> = {};

/**
 * Whether scroll restoration has been initialized
 */
let initialized = false;

/**
 * Custom getKey function for determining scroll restoration key
 */
type GetScrollKeyFunction = (
  location: { pathname: string; search: string; hash: string; key: string }
) => string;

let customGetKey: GetScrollKeyFunction | null = null;

/**
 * Generate a unique key for the current history entry.
 * Uses history.state.key if available, otherwise generates and stores a new one.
 */
export function getHistoryStateKey(): string {
  const state = window.history.state;
  if (state?.key) {
    return state.key;
  }

  // Generate a new key and store it in history.state
  const key = Math.random().toString(36).slice(2, 10);
  window.history.replaceState({ ...state, key }, "");
  return key;
}

/**
 * Get the scroll restoration key for a location.
 * Uses custom getKey function if set, otherwise uses history state key.
 */
export function getScrollKey(): string {
  if (customGetKey) {
    const loc = window.location;
    return customGetKey({
      pathname: loc.pathname,
      search: loc.search,
      hash: loc.hash,
      key: getHistoryStateKey(),
    });
  }
  return getHistoryStateKey();
}

/**
 * Initialize scroll restoration.
 * Sets manual scroll restoration mode and loads saved positions from sessionStorage.
 */
export function initScrollRestoration(options?: {
  getKey?: GetScrollKeyFunction;
}): () => void {
  if (initialized) {
    console.warn("[Scroll] Already initialized");
    return () => {};
  }

  initialized = true;
  customGetKey = options?.getKey ?? null;

  // Set manual scroll restoration to prevent browser's default behavior
  window.history.scrollRestoration = "manual";

  // Load saved positions from sessionStorage
  try {
    const stored = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    if (stored) {
      savedScrollPositions = JSON.parse(stored);
    }
  } catch (e) {
    // Ignore parse errors
  }

  // Ensure current history entry has a key
  getHistoryStateKey();

  // Save scroll positions on pagehide (before leaving/refreshing)
  const handlePageHide = () => {
    saveCurrentScrollPosition();
    persistToSessionStorage();
    // Reset to auto for browser to handle if page is restored from bfcache
    window.history.scrollRestoration = "auto";
  };

  window.addEventListener("pagehide", handlePageHide);

  console.log("[Scroll] Initialized, loaded positions:", Object.keys(savedScrollPositions).length);

  return () => {
    window.removeEventListener("pagehide", handlePageHide);
    window.history.scrollRestoration = "auto";
    initialized = false;
  };
}

/**
 * Save the current scroll position for the current history entry
 */
export function saveCurrentScrollPosition(): void {
  const key = getScrollKey();
  savedScrollPositions[key] = window.scrollY;
}

/**
 * Persist scroll positions to sessionStorage
 */
function persistToSessionStorage(): void {
  try {
    sessionStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(savedScrollPositions));
  } catch (e) {
    console.warn("[Scroll] Failed to persist to sessionStorage:", e);
  }
}

/**
 * Get the saved scroll position for a history key
 */
export function getSavedScrollPosition(key?: string): number | undefined {
  const lookupKey = key ?? getScrollKey();
  return savedScrollPositions[lookupKey];
}

/**
 * Pending poll interval for scroll restoration during streaming
 */
let pendingPollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Cancel any pending scroll restoration polling
 */
export function cancelScrollRestorationPolling(): void {
  if (pendingPollInterval) {
    clearInterval(pendingPollInterval);
    pendingPollInterval = null;
  }
}

/**
 * Restore scroll position for the current history entry.
 * Returns true if position was fully restored, false otherwise.
 *
 * @param options.retryIfStreaming - If true, poll while streaming until we can scroll to target
 * @param options.isStreaming - Function to check if streaming is in progress
 */
export function restoreScrollPosition(options?: {
  retryIfStreaming?: boolean;
  isStreaming?: () => boolean;
}): boolean {
  // Clear any pending polling
  cancelScrollRestorationPolling();

  const key = getScrollKey();
  const savedY = savedScrollPositions[key];

  if (typeof savedY !== "number") {
    return false;
  }

  // Check if page is tall enough to scroll to saved position
  const maxScrollY = document.documentElement.scrollHeight - window.innerHeight;
  const canScrollToPosition = savedY <= maxScrollY;

  if (canScrollToPosition) {
    window.scrollTo(0, savedY);
    console.log("[Scroll] Restored position:", savedY, "for key:", key);
    return true;
  }

  // Scroll as far as we can for now
  window.scrollTo(0, maxScrollY);
  console.log("[Scroll] Partial restore to:", maxScrollY, "target:", savedY);

  // Poll while streaming until we can scroll to target position
  if (options?.retryIfStreaming && options?.isStreaming?.()) {
    const startTime = Date.now();

    pendingPollInterval = setInterval(() => {
      // Stop if we've exceeded the timeout
      if (Date.now() - startTime > SCROLL_POLL_TIMEOUT_MS) {
        console.log("[Scroll] Polling timeout, giving up");
        cancelScrollRestorationPolling();
        return;
      }

      // Stop if streaming ended
      if (!options.isStreaming?.()) {
        console.log("[Scroll] Streaming ended, stopping poll");
        cancelScrollRestorationPolling();
        return;
      }

      // Check if we can now scroll to the target position
      const currentMaxScrollY = document.documentElement.scrollHeight - window.innerHeight;
      if (savedY <= currentMaxScrollY) {
        window.scrollTo(0, savedY);
        console.log("[Scroll] Poll restored position:", savedY);
        cancelScrollRestorationPolling();
      }
    }, SCROLL_POLL_INTERVAL_MS);
  }

  return false;
}

/**
 * Handle hash link scrolling.
 * Scrolls to element with matching ID if hash is present.
 * Returns true if scrolled to element, false otherwise.
 */
export function scrollToHash(): boolean {
  const hash = window.location.hash;
  if (!hash) return false;

  try {
    const id = decodeURIComponent(hash.slice(1));
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView();
      console.log("[Scroll] Scrolled to hash element:", id);
      return true;
    }
  } catch (e) {
    console.warn("[Scroll] Failed to decode hash:", hash);
  }

  return false;
}

/**
 * Scroll to top of page
 */
export function scrollToTop(): void {
  window.scrollTo(0, 0);
}

/**
 * Handle scroll for a new navigation.
 * - Saves current position before navigating
 * - Ensures new history entry has a key
 */
export function handleNavigationStart(): void {
  if (!initialized) return;
  saveCurrentScrollPosition();
}

/**
 * Handle scroll after navigation completes.
 * @param options.restore - If true, restore saved position (for popstate)
 * @param options.scroll - If false, don't scroll at all
 * @param options.isStreaming - Function to check if streaming is in progress (for retry logic)
 */
export function handleNavigationEnd(options: {
  restore?: boolean;
  scroll?: boolean;
  isStreaming?: () => boolean;
}): void {
  if (!initialized) {
    return;
  }

  const { restore = false, scroll = true, isStreaming } = options;

  // Don't scroll if explicitly disabled
  if (scroll === false) {
    return;
  }

  // For back/forward (restore), try to restore saved position
  if (restore) {
    if (restoreScrollPosition({ retryIfStreaming: true, isStreaming })) {
      return;
    }
    // Fall through to hash or top if no saved position
  }

  // Try hash scrolling first
  if (scrollToHash()) {
    return;
  }

  // Default: scroll to top
  scrollToTop();
}

/**
 * Update the history state key after pushState/replaceState.
 * Call this after changing history to ensure new entry has a key.
 */
export function ensureHistoryKey(): void {
  getHistoryStateKey();
}
