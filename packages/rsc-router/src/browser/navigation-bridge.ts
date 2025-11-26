import type {
  NavigationBridge,
  NavigationBridgeConfig,
  NavigateOptions,
  ResolvedSegment,
} from "./types.js";
import { setupLinkInterception } from "./link-interceptor.js";

/**
 * Create a navigation bridge for handling client-side navigation
 *
 * The bridge coordinates all navigation operations:
 * - Link click interception
 * - Browser back/forward (popstate)
 * - Programmatic navigation
 * - Pending state management
 *
 * @param config - Bridge configuration
 * @returns NavigationBridge instance
 *
 * @example
 * ```typescript
 * const bridge = createNavigationBridge({
 *   store,
 *   client,
 *   requestController,
 *   onUpdate: (update) => store.emit(update),
 *   renderSegments,
 * });
 *
 * bridge.registerLinkInterception();
 * ```
 */
export function createNavigationBridge(
  config: NavigationBridgeConfig
): NavigationBridge {
  const { store, client, requestController, onUpdate, renderSegments } = config;

  let isPending = false;
  const pendingSubscribers = new Set<(isPending: boolean) => void>();

  function setPending(value: boolean): void {
    isPending = value;
    pendingSubscribers.forEach((callback) => callback(value));
  }

  /**
   * Fetch partial update and trigger UI update
   */
  async function fetchPartialUpdate(
    targetUrl: string,
    segmentIds?: string[],
    isRetry = false
  ): Promise<void> {
    const segmentState = store.getSegmentState();
    const url = targetUrl || window.location.href;
    const segments = segmentIds ?? segmentState.currentSegmentIds;

    console.log(`\n[Browser] >>> NAVIGATION`);
    console.log(`[Browser] From: ${segmentState.currentUrl}`);
    console.log(`[Browser] To: ${url}`);
    console.log(`[Browser] Segments to send: ${segments.join(", ")}`);

    // Optimistically set the new path
    store.setPath(new URL(url).pathname);

    // Fetch partial payload
    const payload = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl: segmentState.currentUrl,
    });

    if (payload.metadata?.isPartial) {
      const { segments: newSegments, matched, diff } = payload.metadata;

      console.log(`[Browser] Partial update - matched: ${matched?.join(", ")}`);
      console.log(`[Browser] Diff: ${diff?.join(", ")}`);

      // If diff is empty, nothing changed - skip update
      if (!diff || diff.length === 0) {
        console.log(
          `[Browser] No changes - all revalidations returned false, keeping existing UI`
        );
        store.setCurrentUrl(url);
        store.setPath(new URL(url).pathname);
        console.log(`[Browser] Navigation complete (no re-render)\n`);
        return;
      }

      // Update stored segments with new ones
      store.storeSegments(newSegments || []);

      // Build full segment list by merging
      const matchedIds = matched || [];
      const fullSegments = matchedIds
        .map((id: string) => {
          const segment = store.getSegmentState().storedSegments.get(id);
          if (!segment) {
            console.warn(`[Browser] Missing segment: ${id}`);
          }
          return segment;
        })
        .filter(Boolean) as ResolvedSegment[];

      // HMR RESILIENCE: Check if we're missing segments
      if (fullSegments.length < matchedIds.length) {
        const missingCount = matchedIds.length - fullSegments.length;
        const missingIds = matchedIds.filter(
          (id: string) => !store.getSegmentState().storedSegments.has(id)
        );

        if (isRetry) {
          throw new Error(
            `[Browser] Failed to fetch segments after retry. Missing: ${missingIds.join(", ")}`
          );
        }

        console.warn(
          `[Browser] HMR detected: Missing ${missingCount} segments. Refetching all...`
        );

        // Refetch with empty segments = server sends everything
        return fetchPartialUpdate(url, [], true);
      }

      console.log(
        `[Browser] Merged segments: ${fullSegments.map((s) => s.id).join(", ")}`
      );

      // Rebuild tree on client
      const newTree = renderSegments(fullSegments);

      // Update segment IDs
      store.setSegmentIds(matchedIds);
      store.setCurrentUrl(url);

      // Emit update
      onUpdate({
        root: newTree,
        metadata: payload.metadata,
      });

      console.log(`[Browser] Navigation complete\n`);
    } else {
      // Full update (fallback)
      console.warn(`[Browser] Full update (fallback)`);
      store.setSegmentIds(
        payload.metadata?.segments?.map((s: any) => s.id) || []
      );
      store.setCurrentUrl(url);
      store.setPath(new URL(url).pathname);

      onUpdate({
        root: payload.root,
        metadata: payload.metadata!,
      });
    }
  }

  return {
    /**
     * Navigate to a URL
     */
    async navigate(url: string, options?: NavigateOptions): Promise<void> {
      setPending(true);
      const parsedUrl = new URL(url, window.location.origin);

      // Update navigation state to loading with optimistic location
      store.setState({
        state: "loading",
        location: {
          pathname: parsedUrl.pathname,
          search: parsedUrl.search,
          hash: parsedUrl.hash,
          href: parsedUrl.href,
        },
      });

      try {
        // Update browser URL optimistically
        if (options?.replace) {
          window.history.replaceState({}, "", url);
        } else {
          window.history.pushState({}, "", url);
        }

        await fetchPartialUpdate(url);

        // Scroll to top if requested
        if (options?.scroll !== false) {
          window.scrollTo(0, 0);
        }

        // Reset navigation state on success
        store.setState({ state: "idle" });
      } catch (error) {
        // Rollback URL on error
        window.history.back();

        // Reset navigation state with previous location
        store.setState({
          state: "idle",
          location: {
            pathname: window.location.pathname,
            search: window.location.search,
            hash: window.location.hash,
            href: window.location.href,
          },
        });

        throw error;
      } finally {
        setPending(false);
      }
    },

    /**
     * Refresh current route
     */
    async refresh(): Promise<void> {
      setPending(true);
      store.setState({ state: "loading" });

      try {
        // Refetch with empty segments to get everything fresh
        await fetchPartialUpdate(window.location.href, []);
        store.setState({ state: "idle" });
      } catch (error) {
        store.setState({ state: "idle" });
        throw error;
      } finally {
        setPending(false);
      }
    },

    /**
     * Handle browser back/forward navigation
     */
    handlePopstate(): void {
      setPending(true);

      // Update location from browser URL
      store.setState({
        state: "loading",
        location: {
          pathname: window.location.pathname,
          search: window.location.search,
          hash: window.location.hash,
          href: window.location.href,
        },
      });

      fetchPartialUpdate(window.location.href)
        .then(() => {
          store.setState({ state: "idle" });
        })
        .catch(() => {
          store.setState({ state: "idle" });
        })
        .finally(() => {
          setPending(false);
        });
    },

    /**
     * Register link interception
     * @returns Cleanup function
     */
    registerLinkInterception(): () => void {
      const cleanupLinks = setupLinkInterception((url) => {
        this.navigate(url);
      });

      const handlePopstate = () => {
        this.handlePopstate();
      };

      window.addEventListener("popstate", handlePopstate);
      console.log("[Browser] Navigation bridge ready");

      return () => {
        cleanupLinks();
        window.removeEventListener("popstate", handlePopstate);
      };
    },

    /**
     * Subscribe to pending state changes
     * @returns Unsubscribe function
     */
    onPendingChange(callback: (isPending: boolean) => void): () => void {
      pendingSubscribers.add(callback);
      // Immediately notify with current state
      callback(isPending);
      return () => {
        pendingSubscribers.delete(callback);
      };
    },
  };
}

export { createNavigationBridge as default };
