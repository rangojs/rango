"use client";

import { useEffect, useRef } from "react";
import { useLoader } from "@rangojs/router/client";
import { GtmDemoLoader } from "../loaders/gtm-demo.js";
import type { GtmDataLayerEvent } from "../handles/gtm.js";

/** A GA4 ecommerce item. */
export interface GtmItem {
  item_id: string;
  item_name: string;
  item_category?: string;
  price?: number;
  quantity?: number;
}

function pushDataLayer(event: GtmDataLayerEvent) {
  if (typeof window === "undefined") return;
  (window.dataLayer = window.dataLayer ?? []).push(event);
}

function pushEcommerce(event: string, item: GtmItem) {
  // GA4 best practice: clear the previous ecommerce object before each event so
  // values from an earlier event do not leak into this one.
  pushDataLayer({ ecommerce: null });
  const quantity = item.quantity ?? 1;
  pushDataLayer({
    event,
    ecommerce: {
      currency: "USD",
      // Monetary value of the event = unit price x quantity (GA4 expects the
      // total, not the unit price).
      value: item.price != null ? item.price * quantity : undefined,
      items: [item],
    },
  });
}

/**
 * GTM ecommerce demo. Reads the product via useLoader(GtmDemoLoader): the loader
 * is registered on the route with loader(), so its data flows
 * loader -> RSC payload -> client cache, with no server prop threaded through the
 * page. Fires a GA4 view_item once per product (keyed by item_id so StrictMode's
 * double-mount and re-renders never double-count) and an add_to_cart on click;
 * both are client-side dataLayer pushes. Fires on the initial render too, since
 * GA4 ecommerce events are client-side.
 */
export function GtmProduct() {
  const { data: item } = useLoader(GtmDemoLoader);

  const lastId = useRef<string | null>(null);
  useEffect(() => {
    if (lastId.current === item.item_id) return;
    lastId.current = item.item_id;
    pushEcommerce("view_item", item);
  }, [item]);

  return (
    <>
      <p>
        Product: <strong>{item.item_name}</strong> (${item.price})
      </p>
      <button
        type="button"
        data-testid="gtm-add-to-cart"
        onClick={() => pushEcommerce("add_to_cart", { ...item, quantity: 1 })}
      >
        Add to cart
      </button>
    </>
  );
}
