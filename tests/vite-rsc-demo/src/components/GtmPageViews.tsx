"use client";

import { useEffect, useRef } from "react";
import { useHandle } from "@rangojs/router/client";
import {
  Gtm,
  pageViewTagging,
  type GtmDataLayerEvent,
} from "../handles/gtm.js";
import { Meta } from "../handles/meta.js";

function pushDataLayer(event: GtmDataLayerEvent) {
  if (typeof window === "undefined") return;
  (window.dataLayer = window.dataLayer ?? []).push(event);
}

function currentPath(): string | null {
  if (typeof window === "undefined") return null;
  return window.location.pathname + window.location.search;
}

/**
 * Fires a GTM page_view on every soft (client-side) navigation. The FIRST
 * page_view is emitted server-side by the inline Script bootstrap (pushed via
 * ctx.use(Script), rendered by <Html.Scripts/> — visible without JS, no hydration
 * dependency), so this component seeds its last-sent path to the initial
 * location and pushes ONLY when the path changes.
 *
 * It is keyed on the Gtm handle VALUE, not on the URL. Handle values are
 * reactive and arrive on their own channel, by design: on a page React holds in
 * a transition (a transition() route, a same-route search change, a prefetched
 * click) the new URL is visible to hooks before the destination's handle values
 * land in the commit right after the page. An effect keyed on usePathname()
 * would run in the URL's commit and read the PREVIOUS page's content_group and
 * title, and a once-per-URL guard would then skip the late values.
 *
 * So the tie between tagging and page is made explicit: the root @gtmPath slot
 * (revalidate(true), re-run on every navigation) pushes the navigation's own
 * path into the Gtm handle, and this effect depends on that value. A value whose
 * path equals the last one sent is the previous page's (or a repeat) and is
 * skipped; a new path means this page's tagging has arrived. page_title comes
 * from the Meta handle, which commits together with the Gtm handle, rather than
 * from document.title, which TitleUpdater writes in an effect. Covers Link
 * clicks, router.push/replace, popstate, action redirects and query-only
 * navigations through one path, with no double-count on the initial render or
 * under StrictMode's double-mount.
 *
 * The payload matches the first page_view: page_location, page_title and
 * page_referrer (the previous in-app URL, per the GA4 SPA recommendation), plus
 * the handle's page tagging (page_path, content_group, ...) via pageViewTagging.
 *
 * Renders no DOM, so its SSR output (null) cannot drift from the client.
 */
export function GtmPageViews() {
  const page = useHandle(Gtm, (c) => c.page);
  const title = useHandle(Meta, (m) => m?.title);
  const path = page?.path;

  const lastPath = useRef(currentPath());
  // Previous in-app URL, for page_referrer on SPA navigation. Seeded to the
  // initial location so the first soft nav reports the landing page as referrer.
  const prevHref = useRef<string | null>(
    typeof window === "undefined" ? null : window.location.href,
  );

  useEffect(() => {
    if (path === undefined || lastPath.current === path) return;
    lastPath.current = path;
    const href = window.location.origin + path;
    pushDataLayer({
      event: "page_view",
      page_location: href,
      page_title: title ?? document.title,
      page_referrer: prevHref.current ?? document.referrer,
      ...pageViewTagging(page),
    });
    prevHref.current = href;
  }, [path, page, title]);

  return null;
}
