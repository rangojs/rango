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
 * clientUrls() group pinning the data-only transition() projection. The hold
 * is observed on a SAME-route param nav (one -> two), which re-suspends the
 * existing boundary: with transition() the previous content is held — no
 * loading() skeleton flash; the /plain twin without transition() re-streams
 * the skeleton. Same observable as e2e/conditional-transition.test.ts, driven
 * here through the client-declared config.
 */

function TransitionClientLayout() {
  const { content, pending } = useOutlet();

  return (
    <section data-testid="ct-layout" data-pending={String(pending)}>
      <h2>Transition client group</h2>
      {content}
    </section>
  );
}

function TransitionClientItem() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const params = useParams();

  return (
    <article data-testid="ct-item">
      <span data-testid="ct-item-param">{params.itemId}</span>
      <span data-testid="ct-item-loader">{data}</span>
      <Link
        to="/client-urls-transition/items/two"
        prefetch="none"
        data-testid="ct-item-to-two"
      >
        Item two
      </Link>
    </article>
  );
}

function TransitionClientItemLoading() {
  return <div data-testid="ct-item-loading">Loading item</div>;
}

function TransitionClientPlain() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const params = useParams();

  return (
    <article data-testid="ct-plain">
      <span data-testid="ct-plain-param">{params.itemId}</span>
      <span data-testid="ct-plain-loader">{data}</span>
      <Link
        to="/client-urls-transition/plain/two"
        prefetch="none"
        data-testid="ct-plain-to-two"
      >
        Plain two
      </Link>
    </article>
  );
}

function TransitionClientPlainLoading() {
  return <div data-testid="ct-plain-loading">Loading plain</div>;
}

export default clientUrls(({ layout, path, loader, loading, transition }) => [
  layout(TransitionClientLayout, () => [
    path("/items/:itemId", TransitionClientItem, { name: "item" }, () => [
      loader(ClientUrlsItemLoader),
      loading(<TransitionClientItemLoading />),
      transition({ name: "ct-item", viewTransition: "auto" }),
    ]),
    path("/plain/:itemId", TransitionClientPlain, { name: "plain" }, () => [
      loader(ClientUrlsItemLoader),
      loading(<TransitionClientPlainLoading />),
    ]),
  ]),
]);
