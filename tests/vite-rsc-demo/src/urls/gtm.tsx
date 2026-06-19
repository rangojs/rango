import { urls, createLoader, Meta, type Handler } from "@rangojs/router";
import { Gtm } from "../handles/gtm.js";
import { GtmDemoPage } from "../pages/gtm-demo.js";

/** Demo product returned by the loader; its fields become the view_item event. */
export interface GtmDemoItem {
  item_id: string;
  item_name: string;
  item_category: string;
  price: number;
}

/**
 * Loader for the GTM demo product. Runs fresh per request; its data drives the
 * view_item ecommerce event (loader -> server prop -> client dataLayer push).
 */
export const GtmDemoLoader = createLoader(async () => {
  "use server";
  return {
    item_id: "demo-widget",
    item_name: "Demo Widget",
    item_category: "demo",
    price: 19.99,
  } satisfies GtmDemoItem;
});

/**
 * Route handler. Pushes per-route tagging SYNCHRONOUSLY (before awaiting the
 * loader — pushes after an await would arrive late and throw): content_group
 * onto the Gtm handle's page (merged with the layout's page_path), and the
 * document title via Meta (which becomes page_title through document.title, the
 * GA4-standard source). Then awaits the loader and renders the page.
 */
const GtmDemoHandler: Handler<"/"> = async (ctx) => {
  ctx.use(Gtm)({ page: { content_group: "demo" } });
  ctx.use(Meta)({ title: "GTM Demo" });
  const item = await ctx.use(GtmDemoLoader);
  return <GtmDemoPage item={item} />;
};

export const gtmDemoPatterns = urls(({ path, loader }) => [
  path("/", GtmDemoHandler, { name: "index" }, () => [loader(GtmDemoLoader)]),
]);
