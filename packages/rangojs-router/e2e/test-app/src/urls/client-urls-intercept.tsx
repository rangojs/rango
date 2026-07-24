"use client";

import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
} from "@rangojs/router/client";
import { ClientUrlsItemLoader } from "./client-urls.loader.js";

/**
 * Named clientUrls group used as an intercept() TARGET. The wrapping server
 * layout in urls.tsx declares `intercept("@modal", ".clientIntercept.item")`,
 * so navigations to the item route can be claimed as a modal from both a
 * server-page origin and a same-group client origin. Routes are NAMED because
 * intercepts target canonical route names.
 */

function InterceptClientLayout() {
  const { content, pending } = useOutlet();

  return (
    <section data-testid="ci-layout" data-pending={String(pending)}>
      <h2>Intercept client group</h2>
      {content}
    </section>
  );
}

function InterceptClientIndex() {
  return (
    <div data-testid="ci-index">
      <Link
        to="/client-urls-intercept/items/alpha"
        prefetch="none"
        data-testid="ci-item-link"
      >
        Open item
      </Link>
    </div>
  );
}

function InterceptClientItem() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const params = useParams();

  return (
    <article data-testid="ci-item">
      <span data-testid="ci-item-param">{params.itemId}</span>
      <span data-testid="ci-item-loader">{data}</span>
    </article>
  );
}

function InterceptClientLoading() {
  return <div data-testid="ci-item-loading">Loading item</div>;
}

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(InterceptClientLayout, () => [
    path("/", InterceptClientIndex, { name: "index" }),
    path("/items/:itemId", InterceptClientItem, { name: "item" }, () => [
      loader(ClientUrlsItemLoader),
      loading(<InterceptClientLoading />),
    ]),
  ]),
]);
