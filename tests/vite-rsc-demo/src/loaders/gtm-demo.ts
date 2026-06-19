import { createLoader } from "@rangojs/router";

/** Demo product returned by the loader; its fields become the view_item event. */
export interface GtmDemoItem {
  item_id: string;
  item_name: string;
  item_category: string;
  price: number;
}

/**
 * Loader for the GTM demo product. Registered on the /gtm route via the loader()
 * DSL (NOT awaited in the handler) and read on the client with useLoader — its
 * data drives the view_item / add_to_cart ecommerce events, which are client-side
 * GA4 dataLayer pushes, so the data belongs on the client rather than a server
 * prop. Lives in its own module so both the route (loader()) and the client
 * component (useLoader) can import it without a circular dependency.
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
