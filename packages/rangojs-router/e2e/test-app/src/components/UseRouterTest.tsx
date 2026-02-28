"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, useNavigation, useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router/client";

type HookTestLoaderDef = LoaderDefinition<
  { routeId: string; count: number; source: string; timestamp: string },
  Record<string, string | undefined>
>;

/**
 * Test component for useRouter hook.
 * Exposes all 6 methods via buttons with data-testid attributes.
 */
export function UseRouterTest({ loader }: { loader: HookTestLoaderDef }) {
  const router = useRouter();
  const routerRef = useRef(router);
  const [referenceStable, setReferenceStable] = useState(true);
  const [prefetchedUrl, setPrefetchedUrl] = useState<string | null>(null);
  const { data } = useLoader(loader);

  // Track reference stability across renders
  useEffect(() => {
    if (routerRef.current !== router) {
      setReferenceStable(false);
    }
    routerRef.current = router;
  });

  return (
    <div data-testid="use-router-test">
      <h2>useRouter Test</h2>

      {/* Display current state */}
      <div data-testid="router-info">
        <span data-testid="router-ref-stable">
          ref-stable:{referenceStable ? "true" : "false"}
        </span>
        <span data-testid="router-loader-count">count:{data.count}</span>
        <span data-testid="router-loader-source">source:{data.source}</span>
      </div>

      {/* push */}
      <button
        data-testid="router-push-btn"
        onClick={() => router.push("/hook-tests/use-router/target-a")}
      >
        Push to Target A
      </button>

      {/* push with scroll: false */}
      <button
        data-testid="router-push-no-scroll-btn"
        onClick={() =>
          router.push("/hook-tests/use-router/target-a", { scroll: false })
        }
      >
        Push (no scroll)
      </button>

      {/* replace */}
      <button
        data-testid="router-replace-btn"
        onClick={() => router.replace("/hook-tests/use-router/target-b")}
      >
        Replace to Target B
      </button>

      {/* refresh */}
      <button data-testid="router-refresh-btn" onClick={() => router.refresh()}>
        Refresh
      </button>

      {/* prefetch */}
      <button
        data-testid="router-prefetch-btn"
        onClick={() => {
          router.prefetch("/hook-tests/use-router/target-a");
          setPrefetchedUrl("/hook-tests/use-router/target-a");
        }}
      >
        Prefetch Target A
      </button>
      <span data-testid="router-prefetched-url">
        prefetched:{prefetchedUrl ?? "none"}
      </span>

      {/* back */}
      <button data-testid="router-back-btn" onClick={() => router.back()}>
        Back
      </button>

      {/* forward */}
      <button data-testid="router-forward-btn" onClick={() => router.forward()}>
        Forward
      </button>
    </div>
  );
}

/**
 * Simple target page for push/replace navigation.
 * Displays which target it is via data-testid.
 */
export function UseRouterTargetPage({
  targetId,
  loader,
}: {
  targetId: string;
  loader: HookTestLoaderDef;
}) {
  const router = useRouter();
  const { data } = useLoader(loader);

  return (
    <div data-testid={`router-target-${targetId}`}>
      <h2>Target {targetId}</h2>
      <span data-testid="target-id">target:{targetId}</span>
      <span data-testid="target-loader-count">count:{data.count}</span>
      <span data-testid="target-loader-source">source:{data.source}</span>

      <button
        data-testid="target-push-back-btn"
        onClick={() => router.push("/hook-tests/use-router")}
      >
        Push back to useRouter test
      </button>

      <button data-testid="target-back-btn" onClick={() => router.back()}>
        Back
      </button>

      <button data-testid="target-forward-btn" onClick={() => router.forward()}>
        Forward
      </button>
    </div>
  );
}

/**
 * Test component verifying useNavigation only returns state (no methods).
 */
export function UseNavigationStateOnlyTest() {
  const nav = useNavigation();

  // Verify these properties exist (state-only API)
  const hasState = "state" in nav;
  const hasLocation = "location" in nav;
  const hasIsStreaming = "isStreaming" in nav;

  // Verify methods are NOT on navigation anymore
  const hasNavigate = "navigate" in nav;
  const hasRefresh = "refresh" in nav;

  return (
    <div data-testid="nav-state-only-test">
      <span data-testid="nav-has-state">
        has-state:{hasState ? "true" : "false"}
      </span>
      <span data-testid="nav-has-location">
        has-location:{hasLocation ? "true" : "false"}
      </span>
      <span data-testid="nav-has-streaming">
        has-streaming:{hasIsStreaming ? "true" : "false"}
      </span>
      <span data-testid="nav-has-navigate">
        has-navigate:{hasNavigate ? "true" : "false"}
      </span>
      <span data-testid="nav-has-refresh">
        has-refresh:{hasRefresh ? "true" : "false"}
      </span>
      <span data-testid="nav-current-state">nav-state:{nav.state}</span>
      <span data-testid="nav-current-pathname">
        nav-path:{nav.location.pathname}
      </span>
    </div>
  );
}
