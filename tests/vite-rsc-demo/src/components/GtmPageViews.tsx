"use client";

import { useEffect, useRef } from "react";
import {
  usePathname,
  useSearchParams,
  useHandle,
} from "@rangojs/router/client";
import {
  Gtm,
  pageViewTagging,
  type GtmDataLayerEvent,
} from "../handles/gtm.js";

function pushDataLayer(event: GtmDataLayerEvent) {
  if (typeof window === "undefined") return;
  (window.dataLayer = window.dataLayer ?? []).push(event);
}

/**
 * Fires a GTM page_view on every soft (client-side) navigation. The FIRST
 * page_view is emitted server-side by <GtmScript>'s inline init (visible without
 * JS, no hydration dependency), so this effect seeds its key to the initial
 * location and pushes ONLY on change — covering Link clicks, router.push/replace,
 * popstate, and action redirects through one path, with no double-count on the
 * initial render or under StrictMode's double-mount. Keying on pathname+search
 * also catches same-path query-only navigations.
 *
 * The payload matches the first page_view: runtime fields (page_location,
 * page_title) from the live document, page_referrer from the previous in-app URL
 * (GA4 SPA recommendation), and the handle's page tagging (page_path,
 * content_group, ...) via pageViewTagging — so full loads and soft navs produce
 * the same analytics shape.
 *
 * Renders no DOM, so its SSR output (null) cannot drift from the client.
 */
export function GtmPageViews() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const page = useHandle(Gtm, (c) => c.page);
  const navKey = search ? `${pathname}?${search}` : pathname;

  const lastNavKey = useRef(navKey);
  // Previous in-app URL, for page_referrer on SPA navigation. Seeded to the
  // initial location so the first soft nav reports the landing page as referrer.
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
      ...pageViewTagging({ ...page, path: navKey }),
    });
    prevHref.current = window.location.href;
  }, [navKey, page]);

  return null;
}
