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
 * Named clientUrls group exercising both intercept declaration sites:
 * - SERVER-declared: the wrapping layout in urls.tsx declares
 *   `intercept("@modal", ".clientIntercept.item")`, claiming item navigations
 *   from server-page and same-group origins alike.
 * - CLIENT-declared (in-module, below): `intercept("@modal", ".detail", ...)`
 *   is module-local — only in-group origins get the modal; an outside origin
 *   commits the full detail route. Routes are NAMED because intercepts target
 *   canonical route names.
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
      <Link
        to="/client-urls-intercept/detail/gamma"
        prefetch="none"
        data-testid="ci-detail-link"
      >
        Open detail
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

function InterceptClientDetail() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const params = useParams();

  return (
    <article data-testid="ci-detail">
      <span data-testid="ci-detail-param">{params.itemId}</span>
      <span data-testid="ci-detail-loader">{data}</span>
    </article>
  );
}

function InterceptClientDetailModal() {
  const { data } = useLoader(ClientUrlsItemLoader);

  return (
    <dialog open data-testid="ci-client-modal">
      <p data-testid="ci-client-modal-item">{data}</p>
    </dialog>
  );
}

export default clientUrls(({ layout, path, loader, loading, intercept }) => [
  layout(InterceptClientLayout, () => [
    path("/", InterceptClientIndex, { name: "index" }),
    path("/items/:itemId", InterceptClientItem, { name: "item" }, () => [
      loader(ClientUrlsItemLoader),
      loading(<InterceptClientLoading />),
    ]),
    path("/detail/:itemId", InterceptClientDetail, { name: "detail" }, () => [
      loader(ClientUrlsItemLoader),
    ]),
    // Module-local intercept: no `when`, dot-local named target, loader()/
    // loading() only — every field projects as JSON to the server tree.
    intercept("@modal", ".detail", InterceptClientDetailModal, () => [
      loader(ClientUrlsItemLoader),
    ]),
  ]),
]);
