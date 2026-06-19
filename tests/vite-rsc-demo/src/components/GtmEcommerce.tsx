"use client";

import { useEffect, useRef } from "react";
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
 * Fires a GA4 view_item once per product, from loader-derived data passed by the
 * server route as a prop (loader -> server prop -> client dataLayer). Keyed by
 * item_id so StrictMode's double-mount and re-renders never double-count. Fires
 * on the initial render too, since GA4 ecommerce events are client-side.
 */
export function GtmViewItem({ item }: { item: GtmItem }) {
  const lastId = useRef<string | null>(null);
  useEffect(() => {
    if (lastId.current === item.item_id) return;
    lastId.current = item.item_id;
    pushEcommerce("view_item", item);
  }, [item]);
  return null;
}

/**
 * Add-to-cart control that fires a GA4 add_to_cart on click. The dataLayer push
 * is the tagging concern demonstrated here; a real app would also invoke a
 * server action in the same handler.
 */
export function GtmAddToCartButton({ item }: { item: GtmItem }) {
  return (
    <button
      type="button"
      data-testid="gtm-add-to-cart"
      onClick={() => pushEcommerce("add_to_cart", { ...item, quantity: 1 })}
    >
      Add to cart
    </button>
  );
}
