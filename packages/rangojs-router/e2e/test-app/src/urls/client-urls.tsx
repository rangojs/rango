"use client";

import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
} from "@rangojs/router/client";
import { ClientUrlsItemLoader } from "./client-urls.loader.js";

function ClientUrlsLayout() {
  const { content, pending } = useOutlet();

  return (
    <main data-testid="client-urls-layout" data-pending={String(pending)}>
      <h1>Client URLs</h1>
      {content}
    </main>
  );
}

function ClientUrlsIndex() {
  return (
    <section data-testid="client-urls-index">
      <Link
        to="/client-urls-e2e/items/soft-nav"
        prefetch="none"
        data-testid="client-urls-item-link"
      >
        Open item
      </Link>
    </section>
  );
}

function ClientUrlsItem() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const params = useParams();

  return (
    <article data-testid="client-urls-item">
      <div data-testid="client-urls-item-param">{params.itemId}</div>
      <div data-testid="client-urls-item-loader">{data}</div>
      <Link
        to="/client-urls-e2e"
        prefetch="none"
        data-testid="client-urls-index-link"
      >
        Back to index
      </Link>
    </article>
  );
}

function ClientUrlsItemLoading() {
  return <div data-testid="client-urls-item-loading">Loading item</div>;
}

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(ClientUrlsLayout, () => [
    path("/client-urls-e2e", ClientUrlsIndex),
    path("/client-urls-e2e/items/:itemId", ClientUrlsItem, () => [
      loader(ClientUrlsItemLoader),
      loading(<ClientUrlsItemLoading />),
    ]),
  ]),
]);
