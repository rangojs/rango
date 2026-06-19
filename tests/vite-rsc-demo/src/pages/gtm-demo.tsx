import {
  GtmViewItem,
  GtmAddToCartButton,
  type GtmItem,
} from "../components/GtmEcommerce.js";

/**
 * GTM demo page. Server component: receives the loader-fetched item and renders
 * a view_item tag (fires on mount from loader data) plus an add_to_cart control.
 * The page_view for this route is emitted globally by the GTM layout + script.
 */
export function GtmDemoPage({ item }: { item: GtmItem }) {
  return (
    <div data-testid="gtm-demo">
      <h1>GTM Demo</h1>
      <p>
        Product: <strong>{item.item_name}</strong> (${item.price})
      </p>
      <GtmViewItem item={item} />
      <GtmAddToCartButton item={item} />
    </div>
  );
}
