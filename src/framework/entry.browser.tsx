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

async function main() {
  // stash `setPayload` function to trigger re-rendering
  // from outside of `BrowserRoot` component (e.g. server function call, navigation, hmr)
  let setPayload: (v: RscPayload) => void;

  // Track current pathname for partial rendering
  let currentPathname = window.location.pathname;

  // deserialize RSC stream back to React VDOM for CSR
  console.log(`[Browser] ============ INITIAL LOAD ============`);
  console.log(`[Browser] Path: ${window.location.pathname}`);

  const initialPayload = await createFromReadableStream<RscPayload>(
    // initial RSC stream is injected in SSR stream as <script>...FLIGHT_DATA...</script>
    rscStream
  );

  console.log(`[Browser] Initial payload metadata:`, initialPayload.metadata);
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

    const payload = await createFromFetch<RscPayload>(fetch(fetchUrl.href));
    console.log("payload", payload);

    const fetchTime = Date.now() - startTime;
    console.log(`[Browser] ✓ Response received in ${fetchTime}ms`);

    // Log what we received
    if (payload.metadata?.startIndex !== undefined) {
      console.log(`[Browser] Received PARTIAL payload:`);
      console.log(`[Browser]   Start index: ${payload.metadata.startIndex}`);
      console.log(
        `[Browser]   Preserved layouts:`,
        payload.metadata.preservedLayouts
      );
      console.log(`[Browser] ⚠️ WARNING: Partial rendering merge not implemented!`);
      console.log(`[Browser] ⚠️ This will cause layouts to be lost. Using full payload instead.`);
      // TODO: Implement proper partial payload merging
      // For now, we're replacing the entire tree which loses preserved layouts
      // The correct implementation would:
      // 1. Keep the existing layout wrappers from initialPayload or current state
      // 2. Only replace the changed portion starting from startIndex
      // 3. Reconstruct the component tree with preserved layouts wrapping new content
    } else {
      console.log(`[Browser] Received FULL payload`);
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
