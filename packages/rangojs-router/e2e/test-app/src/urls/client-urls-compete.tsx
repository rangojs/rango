"use client";

import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
  useReverse,
} from "@rangojs/router/client";
import { routes } from "./client-urls-compete.gen.js";
import { ClientCompeteItemLoader } from "./client-urls-compete.loader.js";

// A group whose first route after the mount is a param (`/:slug`), mounted
// at "/client-urls-ocompete/:locale?" and "/client-urls-compete/:locale"
// beside server routes its URLs also match (urls.tsx): an unnamed
// "/client-urls-ocompete/login" and "/client-urls-compete/:locale/about".
// Body: tests/shared-e2e/src/client-urls-compete-scenario.ts.

function CompeteLayout() {
  const { content, pending } = useOutlet();
  const reverse = useReverse(routes);
  return (
    <section data-testid="cmp-layout" data-pending={String(pending)}>
      <Link
        to={reverse(".item", { itemId: "alpha" })}
        prefetch="none"
        data-testid="cmp-to-item"
      >
        Item
      </Link>
      <Link
        to={reverse(".product", { slug: "login" })}
        prefetch="none"
        data-testid="cmp-to-login"
      >
        Login
      </Link>
      <Link
        to={reverse(".product", { slug: "about" })}
        prefetch="none"
        data-testid="cmp-to-about"
      >
        About
      </Link>
      {content}
    </section>
  );
}

function CompeteProduct() {
  const { slug } = useParams();
  return <p data-testid={`cmp-product-${slug}`}>{`product:${slug}`}</p>;
}

function CompeteItem() {
  const { data } = useLoader(ClientCompeteItemLoader);
  return <p data-testid="cmp-item-data">{data}</p>;
}

function CompeteDetail() {
  return (
    <article data-testid="cmp-detail">{`detail:${useParams().id}`}</article>
  );
}

function CompeteDetailModal() {
  return (
    <dialog open data-testid="cmp-modal">
      {`modal:${useParams().id}`}
    </dialog>
  );
}

export default clientUrls(({ layout, path, loader, loading, intercept }) => [
  layout(CompeteLayout, () => [
    path("/:slug", CompeteProduct, { name: "product" }),
    path("/items/:itemId", CompeteItem, { name: "item" }, () => [
      loader(ClientCompeteItemLoader),
      loading(<p data-testid="cmp-item-loading">loading item</p>),
    ]),
    path("/detail/:id", CompeteDetail, { name: "detail" }),
    intercept("@modal", ".detail", CompeteDetailModal),
  ]),
]);
