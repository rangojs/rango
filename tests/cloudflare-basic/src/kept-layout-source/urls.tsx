"use client";

import { clientUrls, useParams } from "@rangojs/router/client";

// The #1331 shop: PLPs, a product page and /cart in one clientUrls() group,
// under a server layout whose revalidate() reads the source page's params
// (../pages/kept-layout-source.tsx).
// Body: tests/shared-e2e/src/kept-layout-source-scenario.ts.

function KeptPlp() {
  return <p data-testid="kls-page">{`plp:${useParams().category}`}</p>;
}

function KeptProduct() {
  return <p data-testid="kls-page">{`product:${useParams().productId}`}</p>;
}

function KeptCart() {
  return <p data-testid="kls-page">cart</p>;
}

export default clientUrls(({ path }) => [
  path("/c/:category", KeptPlp),
  path("/p/:productId", KeptProduct),
  path("/cart", KeptCart),
]);
