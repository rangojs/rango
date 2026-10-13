"use client";

import { clientUrls, Link } from "@rangojs/router/client";
import { ComponentUseItem, ComponentUseLayout } from "./components/index.js";

// A group whose layout and page components carry their own items
// (Component.use, components/page.tsx, imported through a barrel): the group
// declares none. Behind a 400 ms server middleware (urls.tsx). Body:
// tests/shared-e2e/src/client-urls-component-use-scenario.ts.

function ComponentUseIndex() {
  return (
    <div data-testid="ccu-index">
      <Link
        to="/client-urls-component-use/items/alpha"
        prefetch="none"
        data-testid="ccu-to-alpha"
      >
        Alpha
      </Link>
    </div>
  );
}

export default clientUrls(({ layout, path }) => [
  layout(ComponentUseLayout, () => [
    path("/", ComponentUseIndex, { name: "index" }),
    path("/items/:id", ComponentUseItem, { name: "item" }),
  ]),
]);
