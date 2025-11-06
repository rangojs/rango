import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  createTemporaryReferenceSet,
  encodeReply,
  callServer,
} from "@vitejs/plugin-rsc/browser";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import { rscStream } from "rsc-html-stream/client";
import type { RscPayload } from "./entry.rsc";
import { OutletProvider } from "./router/Outlet";
export type Segment = {
  index: number;
  pattern: string;
  component: React.ReactNode;
  isLayout: boolean;
};

async function main() {
  // stash `setPayload` function to trigger re-rendering
  // from outside of `BrowserRoot` component (e.g. server function call, navigation, hmr)
  let setPayload: (v: RscPayload) => void;
  let aborter: AbortController | undefined = undefined;
  // Track current pathname for partial rendering
  let currentPathname = window.location.pathname;

  // Track current segments for partial updates
  let currentSegments: Array<Segment> = [];

  // Function to reconstruct tree from segments - returns [tree, segments]
  function reconstructTreeFromSegments(
    segments: Array<Segment>
  ): [React.ReactNode] {
    if (!segments || segments.length === 0) {
      return [null];
    }

    // Build tree from innermost (last) to outermost (first)
    let tree: React.ReactNode = null;

    // Start from the last segment (innermost - usually the page)
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      console.log("segment >", i, segment, { segments });

      tree = React.createElement(
        OutletProvider,
        { content: tree, key: `outlet-${segment.index}` },
        segment.component
      );
    }

    console.log(`[Browser] Tree reconstruction complete`);
    return [tree];
  }

  // deserialize RSC stream back to React VDOM for CSR
  console.log(`[Browser] ============ INITIAL LOAD ============`);
  console.log(`[Browser] Path: ${window.location.pathname}`);

  const initialPayload = await createFromReadableStream<RscPayload>(
    // initial RSC stream is injected in SSR stream as <script>...FLIGHT_DATA...</script>
    rscStream
  );
  currentSegments = initialPayload.metadata?.segments || [];

  console.log(
    `[Browser] Initial payload metadata:`,
    initialPayload.metadata,
    initialPayload
  );
  console.log(`[Browser] ============ END INITIAL LOAD ============\n`);

  // browser root component to (re-)render RSC payload as state
  function BrowserRoot() {
    const [payload, setPayload_] = React.useState(initialPayload);

    React.useEffect(() => {
      setPayload = setPayload_;
      // setPayload = (v) => React.startTransition(() => setPayload_(v));
    }, [setPayload_]);

    // re-fetch/render on client side navigation
    React.useEffect(() => {
      return listenNavigation(() => fetchRscPayload());
    }, []);

    return payload.root;
  }

  // re-fetch RSC and trigger re-rendering
  async function fetchRscPayload(targetUrl?: string) {
    const url = targetUrl || window.location.href;
    const targetPathname = new URL(url, window.location.origin).pathname;

    console.log(`\n[Browser] ============ NAVIGATION ============`);
    console.log(`[Browser] From: ${currentPathname}`);
    console.log(`[Browser] To: ${targetPathname}`);

    // Build fetch URL with partial rendering params
    const fetchUrl = new URL(url, window.location.origin);

    // Only attempt partial rendering if we have metadata from initial payload
    const shouldAttemptPartial =
      currentPathname !== targetPathname && initialPayload.metadata?.pathname;

    if (shouldAttemptPartial) {
      fetchUrl.searchParams.set("_rsc_partial", "true");
      fetchUrl.searchParams.set("_rsc_prev", currentPathname);
      console.log(`[Browser] → Requesting PARTIAL render`);
      console.log(`[Browser]   Previous: ${currentPathname}`);
      console.log(`[Browser]   Target: ${targetPathname}`);
    } else {
      console.log(`[Browser] → Requesting FULL render`);
      console.log(
        `[Browser]   Reason: ${
          currentPathname === targetPathname ? "Same path" : "No metadata"
        }`
      );
    }

    console.log(`[Browser] Fetching: ${fetchUrl.href}`);
    const startTime = Date.now();
    aborter?.abort?.("Cancelled due to new navigation");
    aborter = new AbortController();
    const payload = await createFromFetch<RscPayload>(
      fetch(fetchUrl.href, {
        // signal: aborter?.signal,
      }).catch((err) => {
        console.log(`[Browser] ✗ Fetch error:`, err);
        return new Response(null, { status: 500 });
      }),
      { signal: aborter?.signal }
    );
    console.log("payload", payload);

    if (!payload || aborter?.signal.aborted === true) {
      console.log(
        `[Browser] ✗ Fetch aborted or failed`,
        payload,
        aborter?.signal
      );
      console.log(`[Browser] ============ END NAVIGATION ============\n`);
      return;
    }

    const fetchTime = Date.now() - startTime;
    console.log(`[Browser] ✓ Response received in ${fetchTime}ms`);

    // Log what we received
    if (payload.metadata?.isPartial) {
      console.log(`[Browser] Received PARTIAL payload with segments:`);
      console.log(`[Browser]   Start index: ${payload.metadata.startIndex}`);
      console.log(
        `[Browser]   Preserved layouts:`,
        payload.metadata.preservedLayouts
      );

      // The root is now an array of segments
      if (Array.isArray(payload.metadata.segments)) {
        console.log(
          `[Browser] ✓ Segments array received: ${payload.metadata.segments.length} segments`
        );
        payload.metadata.segments.forEach((seg: Segment) => {
          console.log(
            `[Browser]     - Index ${seg.index}: ${seg.pattern} (${
              seg.isLayout ? "layout" : "page"
            })`
          );
        });

        // Merge segments with existing ones
        console.log(
          `[Browser] Current segments before merge:`,
          currentSegments
        );

        // Start with existing segments up to startIndex
        const preservedSegments = currentSegments.filter(
          (s) => s.index < payload.metadata.startIndex
        );
        console.log(
          `[Browser] Preserving ${preservedSegments.length} segments before index ${payload.metadata.startIndex}`
        );

        // Add new segments
        const newSegments = [
          ...preservedSegments,
          ...payload.metadata.segments,
        ];

        // Sort by index to ensure correct order
        newSegments.sort((a, b) => b.index - a.index);

        // Update current segments
        currentSegments = newSegments;
        console.log(
          `[Browser] Current segments after merge: `,
          currentSegments
        );

        // Reconstruct tree from segments
        const [reconstructedTree] =
          reconstructTreeFromSegments(currentSegments);

        // Update payload with reconstructed tree
        payload.root = reconstructedTree;
        console.log(`[Browser] ✓ Tree reconstructed and payload updated`, {
          reconstructedTree,
        });
      }
    } else if (payload.metadata?.startIndex !== undefined) {
      console.log(`[Browser] Received backwards-compatible PARTIAL payload`);
      console.log(`[Browser]   Start index: ${payload.metadata.startIndex}`);
    } else {
      console.log(`[Browser] Received FULL payload`);
      // For full payloads, reset segments
      // If this is a partial request with segments in root but no isPartial flag

      payload.root = payload.root;
    }

    setPayload(payload);
    currentPathname = targetPathname;
    console.log(`[Browser] ✓ UI updated`);
    console.log(`[Browser] ============ END NAVIGATION ============\n`);
  }

  // register a handler which will be internally called by React
  // on server function request after hydration.
  setServerCallback(async (id, args, ...rest) => {
    console.log("setServerCallback", { id, args, rest });

    const url = new URL(window.location.href);
    const temporaryReferences = createTemporaryReferenceSet();
    const payload = await createFromFetch<RscPayload>(
      fetch(url, {
        method: "POST",
        body: await encodeReply(args, { temporaryReferences }),
        headers: {
          "x-rsc-action": id,
        },
      }),
      { temporaryReferences }
    );
    console.log("payload", payload);
    console.log("payload.returnValue", payload.returnValue);
    // setPayload(payload);

    return payload.returnValue;
  });

  // callServer(async (...args: any[]) => {
  //   console.log("callServer", { args });

  //   const url = new URL(window.location.href);
  // });

  // hydration
  const browserRoot = (
    <React.StrictMode>
      <BrowserRoot />
    </React.StrictMode>
  );
  hydrateRoot(document, browserRoot, {
    formState: initialPayload.formState,
  });

  // implement server HMR by trigering re-fetch/render of RSC upon server code change
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", () => {
      fetchRscPayload();
    });
  }
}

// a little helper to setup events interception for client side navigation
function listenNavigation(onNavigation: () => void) {
  window.addEventListener("popstate", onNavigation);

  const oldPushState = window.history.pushState;
  window.history.pushState = function (...args) {
    const res = oldPushState.apply(this, args);
    onNavigation();
    return res;
  };

  const oldReplaceState = window.history.replaceState;
  window.history.replaceState = function (...args) {
    const res = oldReplaceState.apply(this, args);
    onNavigation();
    return res;
  };

  function onClick(e: MouseEvent) {
    let link = (e.target as Element).closest("a");
    if (
      link &&
      link instanceof HTMLAnchorElement &&
      link.href &&
      (!link.target || link.target === "_self") &&
      link.origin === location.origin &&
      !link.hasAttribute("download") &&
      e.button === 0 && // left clicks only
      !e.metaKey && // open in new tab (mac)
      !e.ctrlKey && // open in new tab (windows)
      !e.altKey && // download
      !e.shiftKey &&
      !e.defaultPrevented
    ) {
      e.preventDefault();
      history.pushState(null, "", link.href);
    }
  }
  document.addEventListener("click", onClick);

  return () => {
    document.removeEventListener("click", onClick);
    window.removeEventListener("popstate", onNavigation);
    window.history.pushState = oldPushState;
    window.history.replaceState = oldReplaceState;
  };
}

main();
