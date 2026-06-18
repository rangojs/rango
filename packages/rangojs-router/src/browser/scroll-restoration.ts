/**
 * Scroll Restoration Module
 *
 * Provides scroll position persistence across navigations, following React Router v7 patterns:
 * - Saves scroll positions to sessionStorage keyed by unique history entry key
 * - Restores scroll on back/forward navigation
 * - Scrolls to top on new navigation (unless scroll: false)
 * - Supports hash link scrolling
 */

import { debugLog } from "./logging.js";

/**
 * Defers a callback to the next animation frame.
 * Falls back to setTimeout(0) in environments without requestAnimationFrame.
 */
const deferToNextPaint: (fn: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);

const SCROLL_STORAGE_KEY = "rsc-router-scroll-positions";

/**
 * Maximum number of scroll position entries to retain.
 * When exceeded, the oldest entries (by insertion order) are evicted.
 * 200 entries is well within sessionStorage limits while covering
 * realistic back/forward navigation depth.
 */
const MAX_SCROLL_ENTRIES = 200;

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
 * Tracks insertion order of scroll position keys for LRU eviction.
 * Most recent entries are at the end of the array.
 * When a key is updated, it is moved to the end.
 */
let scrollKeyOrder: string[] = [];

/**
 * Whether scroll restoration has been initialized
 */
let initialized = false;

/**
 * Custom getKey function for determining scroll restoration key
 */
type GetScrollKeyFunction = (location: {
  pathname: string;
  search: string;
  hash: string;
  key: string;
}) => string;

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
      // Rebuild key order from loaded positions.
      // Exact original order is lost across page loads, but this is
      // acceptable -- the important invariant is bounded size.
      scrollKeyOrder = Object.keys(savedScrollPositions);
    }
  } catch (e) {
    // Ignore parse errors, start with empty state
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

  debugLog(
    "[Scroll] Initialized, loaded positions:",
    Object.keys(savedScrollPositions).length,
  );

  return () => {
    cancelScrollRestorationPolling();
    window.removeEventListener("pagehide", handlePageHide);
    window.history.scrollRestoration = "auto";
    initialized = false;
    savedScrollPositions = {};
    scrollKeyOrder = [];
  };
}

/**
 * Save the current scroll position for the current history entry.
 * Maintains bounded size by evicting oldest entries when the limit is exceeded.
 */
export function saveCurrentScrollPosition(): void {
  const key = getScrollKey();

  // If this key already exists, remove it from its current position
  // in the order array so it can be re-appended at the end (most recent).
  const existingIndex = scrollKeyOrder.indexOf(key);
  if (existingIndex !== -1) {
    scrollKeyOrder.splice(existingIndex, 1);
  }

  savedScrollPositions[key] = window.scrollY;
  scrollKeyOrder.push(key);

  // Evict oldest entries if we exceed the limit
  while (scrollKeyOrder.length > MAX_SCROLL_ENTRIES) {
    const oldestKey = scrollKeyOrder.shift()!;
    delete savedScrollPositions[oldestKey];
  }
}

/**
 * Persist scroll positions to sessionStorage.
 * If the write fails due to quota exceeded, progressively evict the oldest
 * entries and retry until it succeeds or the store is empty.
 *
 * Exported so the quota-exceeded eviction/retry/clear ladder is unit-testable
 * directly. The browser drives it from the `pagehide` handler.
 */
export function persistToSessionStorage(): void {
  try {
    sessionStorage.setItem(
      SCROLL_STORAGE_KEY,
      JSON.stringify(savedScrollPositions),
    );
  } catch (e) {
    // Likely QuotaExceededError. Evict oldest entries and retry.
    const evictCount = Math.max(1, Math.floor(scrollKeyOrder.length / 4));
    for (let i = 0; i < evictCount && scrollKeyOrder.length > 0; i++) {
      const oldestKey = scrollKeyOrder.shift()!;
      delete savedScrollPositions[oldestKey];
    }

    try {
      sessionStorage.setItem(
        SCROLL_STORAGE_KEY,
        JSON.stringify(savedScrollPositions),
      );
    } catch (retryErr) {
      // Storage still full after eviction. Clear our key entirely so we
      // don't block other sessionStorage consumers.
      console.warn(
        "[Scroll] Failed to persist to sessionStorage after eviction, clearing scroll data:",
        retryErr,
      );
      try {
        sessionStorage.removeItem(SCROLL_STORAGE_KEY);
      } catch {
        // Nothing more we can do
      }
    }
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

  // If streaming, poll until streaming ends then scroll to saved position
  if (options?.retryIfStreaming && options?.isStreaming?.()) {
    const startTime = Date.now();

    pendingPollInterval = setInterval(() => {
      if (Date.now() - startTime > SCROLL_POLL_TIMEOUT_MS) {
        debugLog("[Scroll] Polling timeout, giving up");
        cancelScrollRestorationPolling();
        return;
      }

      if (!options.isStreaming?.()) {
        window.scrollTo(0, savedY);
        debugLog("[Scroll] Restored after streaming:", savedY);
        cancelScrollRestorationPolling();
      }
    }, SCROLL_POLL_INTERVAL_MS);

    return true;
  }

  // Not streaming — scroll after React commits and browser paints.
  // startTransition defers the DOM commit, so scrolling synchronously
  // would be overwritten when React replaces the content.
  deferToNextPaint(() => {
    window.scrollTo(0, savedY);
    debugLog("[Scroll] Restored position:", savedY, "for key:", key);
  });
  return true;
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
      debugLog("[Scroll] Scrolled to hash element:", id);
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
  if (typeof window === "undefined") return;
  if (typeof window.scrollTo !== "function") return;
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
  const { restore = false, scroll = true, isStreaming } = options;

  // Don't scroll if explicitly disabled or not in a browser
  if (scroll === false || typeof window === "undefined") {
    return;
  }

  // Save/restore requires initialization (sessionStorage, history state).
  // But basic scroll-to-top and hash scrolling work without it — this
  // matters during cross-app navigation where ScrollRestoration unmounts
  // and remounts, creating a brief window where initialized is false.
  if (restore && initialized) {
    if (restoreScrollPosition({ retryIfStreaming: true, isStreaming })) {
      return;
    }
    // Fall through to hash or top if no saved position
  }

  // scrollToHash / scrollToTop run synchronously here.
  // handleNavigationEnd is invoked from NavigationProvider's
  // useLayoutEffect (post-commit, pre-paint), so a sync scrollTo is
  // captured by the upcoming paint AND by startViewTransition's snapshot.
  // Deferring via rAF here pushed the call past the snapshot capture,
  // making forward navigations wrapped in a layout/route view transition
  // skip scroll-to-top — the live DOM scrolled but the captured snapshot
  // was at the previous scroll position, so the user-facing page stayed
  // visually clamped at the source page's scrollY (often the new tree's
  // max scroll for tall→short navs). Y=0 / a hash element are robust
  // against unmeasured layout, so sync scroll is correct here even
  // before the new tree's scrollHeight settles.
  //
  // (The restore branch above keeps deferToNextPaint because savedY
  // depends on the new tree's max scroll; sync scrollTo against an
  // unmeasured DOM would clamp savedY to whatever the old/zero max was.)
  if (scrollToHash()) {
    return;
  }
  scrollToTop();
}

/**
 * Update the history state key after pushState/replaceState.
 * Call this after changing history to ensure new entry has a key.
 */
export function ensureHistoryKey(): void {
  getHistoryStateKey();
}
