import { Link } from "@rangojs/router/client";
import { GtmActionButton } from "../components/GtmActionButton.js";
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
      <GtmScenarioLinks />
    </div>
  );
}

/**
 * Soft-nav scenario page. The links drive the gtm e2e: a transition() route, a
 * route with the same title as /gtm, a route with no Gtm tagging, and a
 * query-only navigation.
 */
export function GtmScenarioPage({ id, title }: { id: string; title: string }) {
  return (
    <div data-testid={id}>
      <h1>{title}</h1>
      <GtmScenarioLinks />
      <GtmActionButton />
    </div>
  );
}

export function GtmScenarioLinks() {
  return (
    <ul data-testid="gtm-scenario-links">
      <li>
        <Link to="/gtm/transition">transition</Link>
      </li>
      <li>
        <Link to="/gtm/same-title">same title</Link>
      </li>
      <li>
        <Link to="/gtm/untagged">untagged</Link>
      </li>
      <li>
        <Link to="/gtm?q=a">query a</Link>
      </li>
      <li>
        <Link to="/gtm?q=b">query b</Link>
      </li>
    </ul>
  );
}
