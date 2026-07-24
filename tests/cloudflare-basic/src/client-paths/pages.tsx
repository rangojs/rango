"use client";

import { useState, type ReactNode } from "react";
import { Link, useLoader, useParams } from "@rangojs/router/client";
import { MixedClientDetailLoader } from "./loader.js";

export function MixedClientIndex(): ReactNode {
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

export function MixedClientDetail(): ReactNode {
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
