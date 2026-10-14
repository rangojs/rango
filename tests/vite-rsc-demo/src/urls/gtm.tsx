import { urls, Meta, Script, type Handler } from "@rangojs/router";
import { Gtm, DEFAULT_GTM_ID, generateGtmInit } from "../handles/gtm.js";
import { GtmDemoLoader } from "../loaders/gtm-demo.js";
import { GtmDemoPage, GtmScenarioPage } from "../pages/gtm-demo.js";

/**
 * Route handler. Pushes per-route tagging SYNCHRONOUSLY:
 *
 * - OVERRIDES the GTM bootstrap by reusing the "gtm" Script id, baking
 *   content_group into the FIRST (hard-load) page_view server-side. The Script
 *   handle is collected after handlers (parent -> child, last-wins), so this
 *   replaces the layout `@gtm` slot's generic bootstrap on /gtm — content_group
 *   lands in the static HTML, which a head-only server component cannot do.
 * - content_group onto the Gtm handle for the SOFT-nav page_view (<GtmPageViews>).
 * - document title via Meta (becomes page_title through document.title).
 * - two more Script scenarios that demonstrate the execution contract:
 *   - Plausible as an external ASYNC resource — React loads it on first visit to
 *     /gtm, whether reached by hard load OR soft navigation (async = resource).
 *   - a body-positioned INLINE script — document-load only: it runs on a hard
 *     load of /gtm, but a soft navigation to /gtm does NOT re-run it (<Html.Scripts/>
 *     freezes the non-async set after hydration).
 *
 * The product data is NOT awaited here: it is registered via the loader() DSL
 * below and read on the client with useLoader (<GtmProduct>), since the view_item
 * / add_to_cart events it drives are client-side dataLayer pushes.
 */
const GtmDemoHandler: Handler<"/"> = (ctx) => {
  ctx.use(Script)({
    id: "gtm",
    children: generateGtmInit(DEFAULT_GTM_ID, { content_group: "demo" }),
  });
  ctx.use(Script)({
    id: "plausible",
    src: "https://plausible.io/js/script.js",
    async: true,
    attributes: { "data-domain": "example.com" },
  });
  ctx.use(Script)({
    id: "gtm-demo-body",
    position: "body",
    children: "window.__gtmDemoBody = true;",
  });
  ctx.use(Gtm)({ page: { content_group: "demo" } });
  ctx.use(Meta)({ title: "GTM Demo" });
  return <GtmDemoPage />;
};

/**
 * Soft-nav page_view scenarios (GtmPageViews keys on the Gtm handle value, which
 * carries the navigation's path from the root @gtmPath slot):
 * - /transition: a transition() route, so React holds the page being left and
 *   the destination's handle values land in the commit after the page.
 * - /same-title: pushes the SAME title as /gtm, so a title change cannot be what
 *   triggers the page_view.
 * - /untagged: pushes no Gtm tagging of its own; its path comes from the slot.
 */
const GtmTransitionHandler: Handler<"/transition"> = (ctx) => {
  ctx.use(Gtm)({ page: { content_group: "transition" } });
  ctx.use(Meta)({ title: "GTM Transition" });
  return <GtmScenarioPage id="gtm-transition" title="GTM Transition" />;
};

const GtmSameTitleHandler: Handler<"/same-title"> = (ctx) => {
  ctx.use(Gtm)({ page: { content_group: "same-title" } });
  ctx.use(Meta)({ title: "GTM Demo" });
  return <GtmScenarioPage id="gtm-same-title" title="GTM Demo" />;
};

const GtmUntaggedHandler: Handler<"/untagged"> = () => (
  <GtmScenarioPage id="gtm-untagged" title="Untagged" />
);

export const gtmDemoPatterns = urls(({ path, loader, transition }) => [
  path("/", GtmDemoHandler, { name: "index" }, () => [loader(GtmDemoLoader)]),
  path("/transition", GtmTransitionHandler, { name: "transition" }, () => [
    transition({ viewTransition: false }),
  ]),
  path("/same-title", GtmSameTitleHandler, { name: "sameTitle" }),
  path("/untagged", GtmUntaggedHandler, { name: "untagged" }),
]);
