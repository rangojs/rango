"use client";

import { useState, useTransition } from "react";
import {
  useFetchLoader,
  useLoader,
  useRefreshLoaders,
} from "@rangojs/router/client";
import {
  CartLoader,
  ProductsPageLoader,
  type ProductRow,
} from "../../handlers/refresh-demo/loaders.js";
import { addToCart } from "../../handlers/refresh-demo/cart.actions.js";

const badgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid #d0d7de",
  background: "#f6f8fa",
  fontSize: 14,
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 760,
  marginTop: 12,
  borderCollapse: "collapse",
  fontSize: 14,
};
const thtd: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid #eaeef2",
};
const addButtonStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "4px 10px",
  borderRadius: 7,
  border: "1px solid #1f883d",
  background: "#1f883d",
  color: "#fff",
  cursor: "pointer",
};
const moreButtonStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 13,
  padding: "6px 12px",
  borderRadius: 7,
  border: "1px solid #d0d7de",
  background: "#f6f8fa",
  cursor: "pointer",
};

/**
 * Cart badge — reads CartLoader with a shared key and a refreshGroup. Two of
 * these on the page (header + sidebar) read the same bucket, so when an add-to-
 * cart refreshes the group the new count fans out to both from one fetch.
 */
export function CartBadge({ id, label }: { id: string; label: string }) {
  const { data, isLoading } = useLoader(CartLoader, {
    key: "cart",
    refreshGroup: "cart",
  });
  return (
    <span
      data-testid={`pc-badge-${id}`}
      style={badgeStyle}
      aria-busy={isLoading}
    >
      <span style={{ color: "#57606a" }}>{label}</span>
      <strong data-testid={`pc-badge-${id}-count`}>{data.count}</strong>
    </span>
  );
}

/**
 * Add-to-cart button. The write is a server action (addToCart); the cart
 * re-render is driven by the client refresh primitive (useRefreshLoaders) — the
 * action's return value is intentionally unused. One refresh re-reads CartLoader
 * and fans the new count out to every cart badge.
 */
function AddToCartButton({ id }: { id: string }) {
  const refreshCart = useRefreshLoaders();
  const [pending, startTransition] = useTransition();
  return (
    <button
      data-testid={`pc-add-${id}`}
      style={addButtonStyle}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await addToCart(id);
          await refreshCart("cart").catch(() => {});
        })
      }
    >
      {pending ? "Adding…" : "Add to cart"}
    </button>
  );
}

/**
 * Paginated products table. The first page is SSR-seeded; "Load more" fetches
 * the next page via load({ params: { cursor } }) and appends it to the growing
 * local list, so the table accumulates rows without a navigation.
 */
export function ProductsTable() {
  const { data, load } = useFetchLoader(ProductsPageLoader);
  const [rows, setRows] = useState<ProductRow[]>(() => data?.items ?? []);
  const [cursor, setCursor] = useState<number | null>(data?.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadMore = async () => {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await load({ params: { cursor: String(cursor) } });
      setRows((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div>
      <table data-testid="pc-table" style={tableStyle}>
        <thead>
          <tr>
            <th style={thtd}>Product</th>
            <th style={thtd}>Price</th>
            <th style={thtd}>Rating</th>
            <th style={thtd}>Stock</th>
            <th style={thtd} />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} data-testid={`pc-row-${p.id}`}>
              <td style={thtd}>{p.name}</td>
              <td style={thtd}>{p.price}</td>
              <td style={thtd}>{p.rating}</td>
              <td style={thtd}>{p.stock}</td>
              <td style={thtd}>
                <AddToCartButton id={p.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cursor !== null ? (
        <button
          data-testid="pc-load-more"
          style={moreButtonStyle}
          disabled={loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : (
        <p
          data-testid="pc-load-more-done"
          style={{ color: "#8b949e", marginTop: 12 }}
        >
          All products loaded.
        </p>
      )}
    </div>
  );
}
