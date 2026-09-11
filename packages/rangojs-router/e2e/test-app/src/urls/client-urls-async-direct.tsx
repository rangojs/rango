"use client";

import { clientUrls, Link, useParams } from "@rangojs/router/client";

// Mounted DIRECTLY through an async include in urls.tsx (no server urls()
// wrapper module): `include(prefix, () => import("./client-urls-async-direct.js"))`.

function AsyncDirectIndex() {
  return (
    <div data-testid="cad-index">
      <Link
        to="/client-urls-async-direct/items/beta"
        prefetch="none"
        data-testid="cad-item-link"
      >
        Open beta
      </Link>
    </div>
  );
}

function AsyncDirectItem() {
  const { itemId } = useParams<{ itemId: string }>();
  return (
    <div data-testid="cad-item">{`client-urls-async-direct:${itemId}`}</div>
  );
}

export default clientUrls(({ path }) => [
  path("/", AsyncDirectIndex, { name: "index" }),
  path("/items/:itemId", AsyncDirectItem, { name: "item" }),
]);
