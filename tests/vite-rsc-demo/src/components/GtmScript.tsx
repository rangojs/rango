"use client";

import { useState } from "react";
import { useHandle, useNonce } from "@rangojs/router/client";
import { Gtm, generateGtmInit, gtmNoScriptSrc } from "../handles/gtm.js";

/**
 * Injects GTM into the document <head> via a single nonced inline bootstrap
 * script: it initialises window.dataLayer, fires the gtm.js start event, emits
 * the FIRST page_view, and then injects the gtm.js loader (Google's canonical
 * snippet). Injecting the loader from the inline script — rather than rendering a
 * declarative <script async> — is deliberate: React 19 would hoist a declarative
 * async script ABOVE this bootstrap, so gtm.js could run before dataLayer exists.
 *
 * The nonce is server-only (useNonce() is undefined in the browser), so the
 * script carries suppressHydrationWarning; its content is frozen to the first
 * render so it is byte-identical across SSR and hydration and runs exactly once.
 * Subsequent page_views are fired by <GtmPageViews>.
 */
export function GtmScript() {
  const config = useHandle(Gtm);
  const nonce = useNonce();

  const containerId = config.containerId;
  const [initScript] = useState(() =>
    containerId ? generateGtmInit(containerId, config.page) : "",
  );

  if (!containerId) return null;

  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: initScript }}
    />
  );
}

/**
 * GTM <noscript> fallback iframe. Rendered at the top of <body> so it is present
 * in the server HTML for clients without JavaScript (which never run the inline
 * bootstrap, so gtm.js is never injected for them). The container id comes from
 * the same handle as <GtmScript>, so SSR and hydration agree.
 */
export function GtmNoScript() {
  const containerId = useHandle(Gtm, (c) => c.containerId);
  if (!containerId) return null;

  return (
    <noscript>
      <iframe
        src={gtmNoScriptSrc(containerId)}
        height="0"
        width="0"
        style={{ display: "none", visibility: "hidden" }}
        title="gtm"
      />
    </noscript>
  );
}
