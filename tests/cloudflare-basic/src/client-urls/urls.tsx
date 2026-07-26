"use client";

import type { ReactNode } from "react";
import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
} from "@rangojs/router/client";
import { ClientUrlsDetailLoader } from "./loader.js";

function ClientUrlsLayout(): ReactNode {
  const outlet = useOutlet();

  return (
    <main data-testid="client-urls-layout">
      <h1>Pure client routes</h1>
      <nav aria-label="Pure client route navigation">
        <Link to="/" data-testid="client-urls-main-nav">
          Server route examples
        </Link>
        <Link to="/__client-urls" data-testid="client-urls-index-nav">
          Pure client index
        </Link>
      </nav>
      <output data-testid="client-urls-pending">
        {String(outlet.pending)}
      </output>
      {outlet.content}
    </main>
  );
}

function ClientUrlsIndex(): ReactNode {
  return (
    <section data-testid="client-urls-index">
      <h2>Client URLs index</h2>
      <Link
        to="/__client-urls/deterministic-slug"
        prefetch="none"
        data-testid="client-urls-detail-link"
      >
        Open detail
      </Link>
    </section>
  );
}

function ClientUrlsDetail(): ReactNode {
  const { slug } = useParams<{ slug: string }>();
  const { data } = useLoader(ClientUrlsDetailLoader);

  return (
    <section data-testid="client-urls-detail">
      <h2>Client URLs detail</h2>
      <p data-testid="client-urls-param">{slug}</p>
      <p data-testid="client-urls-loader">{data.slug}</p>
      <Link
        to="/__client-urls"
        prefetch="none"
        data-testid="client-urls-back-link"
      >
        Back to index
      </Link>
    </section>
  );
}

function ClientUrlsLoading(): ReactNode {
  return (
    <section data-testid="client-urls-loading">
      Loading client URL detail
    </section>
  );
}

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(ClientUrlsLayout, () => [
    path("/", ClientUrlsIndex),
    path("/:slug", ClientUrlsDetail, () => [
      loader(ClientUrlsDetailLoader),
      loading(<ClientUrlsLoading />),
    ]),
  ]),
]);
