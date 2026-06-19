import { GtmProduct } from "../components/GtmEcommerce.js";

/**
 * GTM demo page. The product data is registered on the route via the loader()
 * DSL and read on the client by <GtmProduct> (useLoader) — it is NOT awaited in
 * the handler, because the view_item / add_to_cart events it drives are
 * client-side. The page_view for this route is emitted globally by the GTM layout
 * + script.
 */
export function GtmDemoPage() {
  return (
    <div data-testid="gtm-demo">
      <h1>GTM Demo</h1>
      <GtmProduct />
    </div>
  );
}
