"use client";

import { useState, type ReactNode } from "react";
import { clientUrls, Link, useLoader, useParams } from "@rangojs/router/client";
import { MixedClientDetailLoader } from "./loader.js";

// The mixed example: this clientUrls() group is mounted through include()
// UNDER an ordinary RSC layout (see urls.tsx) — the layout stays a Server
// Component while these pages keep browser-local matching and optimistic
// presentation. Patterns are definition-local; the include supplies the
// "/mixed-client-routes" URL prefix and the "mixedClient" name prefix.

function MixedClientIndex(): ReactNode {
  const [count, setCount] = useState(0);

  return (
    <section data-testid="mixed-client-index">
      <h2>Client index page</h2>
      <p>This interactive page is rendered inside an RSC route layout.</p>
      <button
        type="button"
        data-testid="mixed-client-counter"
        onClick={() => setCount((value) => value + 1)}
      >
        Client count: {count}
      </button>
      <Link
        to="/mixed-client-routes/example"
        data-testid="mixed-client-detail-link"
      >
        Open client detail
      </Link>
    </section>
  );
}

function MixedClientDetail(): ReactNode {
  const { slug } = useParams<{ slug: string }>();
  const { data } = useLoader(MixedClientDetailLoader);

  return (
    <section data-testid="mixed-client-detail">
      <h2>Client detail page</h2>
      <p data-testid="mixed-client-param">{slug}</p>
      <p data-testid="mixed-client-loader">
        {data.source}: {data.slug}
      </p>
      <Link to="/mixed-client-routes" data-testid="mixed-client-index-link">
        Back to client index
      </Link>
    </section>
  );
}

export default clientUrls(({ path, loader, loading }) => [
  path("/", MixedClientIndex, { name: "index" }),
  path("/:slug", MixedClientDetail, { name: "detail" }, () => [
    loader(MixedClientDetailLoader),
    loading(<p data-testid="mixed-client-loading">Loading server data...</p>),
  ]),
]);
