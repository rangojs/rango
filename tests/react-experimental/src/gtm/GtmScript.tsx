"use client";

import { useState } from "react";
import { usePathname, useNonce } from "@rangojs/router/client";
import { DEFAULT_GTM_ID, generateGtmInit, gtmNoScriptSrc } from "./gtm.js";

/**
 * Injects GTM into <head> via a single nonced inline bootstrap that initialises
 * dataLayer, emits the first page_view, and injects the gtm.js loader (Google's
 * canonical snippet — injecting from the inline script avoids React 19 hoisting a
 * declarative async script above the bootstrap). The nonce is server-only, so the
 * script carries suppressHydrationWarning; its content is frozen to the first
 * render so it is byte-identical across SSR and hydration. This is the surface
 * most likely to regress under experimental React (nonce stamping + hydration).
 */
export function GtmScript() {
  const pathname = usePathname();
  const nonce = useNonce();

  const [initScript] = useState(() =>
    generateGtmInit(DEFAULT_GTM_ID, { path: pathname }),
  );

  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: initScript }}
    />
  );
}

export function GtmNoScript() {
  return (
    <noscript>
      <iframe
        src={gtmNoScriptSrc(DEFAULT_GTM_ID)}
        height="0"
        width="0"
        style={{ display: "none", visibility: "hidden" }}
        title="gtm"
      />
    </noscript>
  );
}
