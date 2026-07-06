import React from "react";
import { renderSegments } from "../segment-system.js";
import {
  filterSegmentOrder,
  filterRouteSegmentIds,
} from "../browser/react/filter-segment-order.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { NonceContext } from "../browser/react/nonce-context.js";
import { NavigationStoreContext } from "../browser/react/context.js";
import type { NavigationStoreContextValue } from "../browser/react/context.js";
import type { HandleData } from "../browser/types.js";
import type { ResolvedSegment } from "../types.js";
import type { ResolvedThemeConfig, Theme } from "../theme/types.js";
import type {
  EventController,
  DerivedNavigationState,
} from "../browser/event-controller.js";

/**
 * createFromReadableStream from @rangojs/router/internal/deps/ssr.
 * Deserializes the Flight branch used to build the SSR VDOM.
 */
export type CreateFromReadableStream = <T>(
  stream: ReadableStream<Uint8Array>,
) => Promise<T>;

/**
 * RSC payload type (minimal interface for SSR)
 */
export interface RscPayload {
  metadata?: {
    segments?: ResolvedSegment[];
    rootLayout?: React.ComponentType<{ children: React.ReactNode }>;
    handles?: AsyncGenerator<HandleData, void, unknown>;
    matched?: string[];
    pathname?: string;
    params?: Record<string, string>;
    basename?: string;
    themeConfig?: ResolvedThemeConfig | null;
    initialTheme?: Theme;
    version?: string;
  };
}

/**
 * Consume an async generator and return a Promise that resolves with the final value.
 * Used for SSR where we need to await all handle data before rendering.
 */
async function consumeAsyncGenerator(
  generator: AsyncGenerator<HandleData, void, unknown>,
): Promise<HandleData> {
  let lastData: HandleData = {};
  for await (const data of generator) {
    lastData = data;
  }
  return lastData;
}

/**
 * Create a minimal event controller for SSR.
 * This provides the correct pathname so useNavigation returns the right value during SSR.
 */
function createSsrEventController(opts: {
  pathname: string;
  params?: Record<string, string>;
  handleData?: HandleData;
  matched?: string[];
}): EventController {
  const location = new URL(opts.pathname, "http://localhost");
  let params = opts.params ?? {};
  const rawMatched = opts.matched ?? [];
  const handleState = {
    data: opts.handleData ?? {},
    segmentOrder: filterSegmentOrder(rawMatched),
    routeSegmentIds: filterRouteSegmentIds(rawMatched),
  };
  const state: DerivedNavigationState = {
    state: "idle",
    isStreaming: false,
    isNavigating: false,
    location,
    pendingUrl: null,
    inflightActions: [],
  };

  return {
    getState: () => state,
    getLocation: () => location,
    subscribe: () => () => {},
    getActionState: () => ({
      state: "idle",
      actionId: null,
      payload: null,
      error: null,
      result: null,
    }),
    subscribeToAction: () => () => {},
    subscribeToHandles: () => () => {},
    setHandleData: () => {},
    getHandleState: () => handleState,
    setRouteSegmentIds: () => {},
    setParams: (nextParams) => {
      params = nextParams;
    },
    getParams: () => params,
    setLocation: () => {},
    startNavigation: () => {
      throw new Error("Navigation not supported during SSR");
    },
    abortNavigation: () => {},
    startAction: () => {
      throw new Error("Actions not supported during SSR");
    },
    abortAllActions: () => {},
    getCurrentNavigation: () => null,
    getInflightActions: () => new Map(),
    hadAnyConcurrentActions: () => false,
  };
}

/**
 * Options for {@link createSsrRootComponent}.
 */
export interface SsrRootOptions {
  /** createFromReadableStream for the SSR branch of the Flight stream. */
  createFromReadableStream: CreateFromReadableStream;
  /** The Flight stream branch to deserialize into the SSR VDOM. */
  rscStream: ReadableStream<Uint8Array>;
  /** Nonce for CSP; propagated to NonceContext. */
  nonce?: string;
  /**
   * Fires once when the Flight payload root settles (resolve OR reject) — the
   * signal that every client-module load the payload references completed and
   * fizz can start emitting the tree. The capture pass gates its abort on
   * this: a fully REPLAYED (prerendered) route's Flight stream goes
   * byte-quiet in ~1-3ms, but fizz cannot render even <html> until the
   * module loads finish (real module-runner I/O in dev; 100ms+ on a cold
   * graph), so an abort gated on Flight quiet alone fires first and freezes
   * a zero-byte prelude. Masked-loader holes do NOT block this signal —
   * they postpone below the root.
   */
  onPayloadSettled?: () => void;
}

/**
 * Build the closure component that deserializes the Flight payload, consumes
 * handles to completion, builds the segment tree, and wraps it in the
 * NavigationStore / Nonce / Theme providers.
 *
 * The full-fizz path (renderHTML), the shell prerender pass (capture), and the
 * shell resume pass all render this identical tree. `resume` requires the tree
 * above the postponed holes to match the prerendered tree; rendering the same
 * builder over the same replayed segments is what makes that hold. A fresh
 * component instance per pass is fine — replay matches structure, not function
 * identity.
 *
 * The memo slots (payload/handles/context/root) are closure-scoped to the
 * returned instance, so each render pass memoizes independently. renderSegments
 * is async: React.use() on a fresh promise would suspend and replay SsrRoot,
 * re-running the whole segment-tree build unless the promise is memoized.
 */
export function createSsrRootComponent(opts: SsrRootOptions): React.FC {
  const { createFromReadableStream, rscStream, nonce, onPayloadSettled } = opts;

  let payload: Promise<RscPayload> | undefined;
  let handlesPromise: Promise<HandleData> | undefined;
  let ssrContextValue: NavigationStoreContextValue | undefined;
  let rootPromise: Promise<React.ReactNode> | undefined;

  return function SsrRoot() {
    if (payload === undefined) {
      payload = createFromReadableStream<RscPayload>(rscStream);
      if (onPayloadSettled) payload.then(onPayloadSettled, onPayloadSettled);
    }
    const resolved = React.use(payload);

    const themeConfig = resolved.metadata?.themeConfig ?? null;
    const pathname = resolved.metadata?.pathname ?? "/";

    // Await handles before creating SSR event controller so hooks can
    // read request-local handle data via NavigationStoreContext.
    // The handles property is an async generator that yields on each push
    // Memoize the promise since async generators can only be iterated once
    let handleData: HandleData = {};
    if (resolved.metadata?.handles) {
      handlesPromise ??= consumeAsyncGenerator(resolved.metadata.handles);
      handleData = React.use(handlesPromise);
    }

    // Create SSR context with request-local pathname/params/handles.
    ssrContextValue ??= {
      store: null as any,
      eventController: createSsrEventController({
        pathname,
        params: resolved.metadata?.params,
        handleData,
        matched: resolved.metadata?.matched,
      }),
      navigate: async () => {},
      refresh: async () => {},
      version: resolved.metadata?.version,
      basename: resolved.metadata?.basename,
    };

    // Build content tree from segments.
    // Order must match NavigationProvider: NavigationStoreContext > NonceContext > ThemeProvider > content
    // Memoize like payload/handles above: renderSegments is async, so
    // React.use() on a fresh promise suspends and replays SsrRoot, which
    // would re-run the entire segment-tree build on every initial render.
    rootPromise ??= Promise.resolve(
      renderSegments(resolved.metadata?.segments ?? [], {
        rootLayout: resolved.metadata?.rootLayout,
      }),
    );
    let content: React.ReactNode = React.use(rootPromise);

    // Wrap content with ThemeProvider if theme is enabled
    if (themeConfig) {
      content = (
        <ThemeProvider
          config={themeConfig}
          initialTheme={resolved.metadata?.initialTheme}
        >
          {content}
        </ThemeProvider>
      );
    }

    // Wrap with NonceContext so client components (e.g. MetaTags) can
    // apply CSP nonces to inline scripts during SSR. Always present to
    // match the browser-side NavigationProvider tree shape for hydration.
    content = (
      <NonceContext.Provider value={nonce}>{content}</NonceContext.Provider>
    );

    // Wrap with NavigationStoreContext for useNavigation hook
    return (
      <NavigationStoreContext.Provider value={ssrContextValue!}>
        {content}
      </NavigationStoreContext.Provider>
    );
  };
}
