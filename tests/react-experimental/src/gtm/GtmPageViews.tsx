"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "@rangojs/router/client";
import { pageViewTagging, type GtmDataLayerEvent } from "./gtm.js";

function pushDataLayer(event: GtmDataLayerEvent) {
  if (typeof window === "undefined") return;
  (window.dataLayer = window.dataLayer ?? []).push(event);
}

/**
 * Fires a GTM page_view on each soft navigation. The first page_view is emitted
 * server-side by the inline Script bootstrap (rendered by <Scripts/>), so this
 * seeds its key to the initial location and fires only on change. Payload mirrors
 * the first page_view: runtime fields from
 * the live document plus page_referrer from the previous in-app URL. Under
 * experimental React the location hooks re-render inside startViewTransition; the
 * effect still runs once per committed nav.
 */
export function GtmPageViews() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const navKey = search ? `${pathname}?${search}` : pathname;

  const lastNavKey = useRef(navKey);
  const prevHref = useRef<string | null>(
    typeof window === "undefined" ? null : window.location.href,
  );

  useEffect(() => {
    if (lastNavKey.current === navKey) return;
    lastNavKey.current = navKey;
    pushDataLayer({
      event: "page_view",
      page_location: window.location.href,
      page_title: document.title,
      page_referrer: prevHref.current ?? document.referrer,
      ...pageViewTagging({ path: navKey }),
    });
    prevHref.current = window.location.href;
  }, [navKey]);

  return null;
}
