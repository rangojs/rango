"use client";

import { useState } from "react";
import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
  useReverse,
} from "@rangojs/router/client";
import { routes } from "./client-urls-locale.gen.js";
import { ClientLocaleItemLoader } from "./client-urls-locale.loader.js";
import { echoClientLocaleItem } from "./client-urls-locale.actions.js";

// A group mounted under a parameterized include() (urls.tsx mounts it at
// "/client-urls-locale/:locale" and "/client-urls-olocale/:locale?"), behind
// a 400 ms server middleware. Links are local names, so they carry the
// mount's params. Body: tests/shared-e2e/src/client-urls-locale-scenario.ts.

function LocaleLayout() {
  const { content, pending } = useOutlet();
  const reverse = useReverse(routes);
  return (
    <section data-testid="clo-layout" data-pending={String(pending)}>
      <p data-testid="clo-locale">{useParams().locale ?? "-"}</p>
      <Link
        to={reverse(".item", { itemId: "alpha", locale: "de" })}
        prefetch="none"
        data-testid="clo-to-de"
      >
        Deutsch
      </Link>
      {content}
    </section>
  );
}

function LocaleIndex() {
  const reverse = useReverse(routes);
  return (
    <div data-testid="clo-index">
      <Link
        to={reverse(".item", { itemId: "alpha" })}
        prefetch="none"
        data-testid="clo-to-alpha"
      >
        Alpha
      </Link>
      <Link
        to={reverse(".note", { noteId: "n1" })}
        prefetch="none"
        data-testid="clo-to-note"
      >
        Note
      </Link>
    </div>
  );
}

/** Reads the frame's params: the mount's locale and the item. */
function LocaleItemLoading() {
  const { locale, itemId } = useParams();
  return (
    <p data-testid="clo-item-loading">{`loading:${locale ?? "-"}:${itemId}`}</p>
  );
}

function LocaleItem() {
  const { data } = useLoader(ClientLocaleItemLoader);
  const reverse = useReverse(routes);
  const { itemId = "" } = useParams();
  const [echo, setEcho] = useState("");
  return (
    <div data-testid="clo-item">
      <p data-testid="clo-item-data">{data}</p>
      <p data-testid="clo-echo">{echo}</p>
      <button
        data-testid="clo-action"
        onClick={async () => setEcho(await echoClientLocaleItem(itemId))}
      >
        Echo
      </button>
      <Link
        to={reverse(".item", { itemId: "beta" })}
        prefetch="none"
        data-testid="clo-to-beta"
      >
        Beta
      </Link>
      <Link to={reverse(".index")} prefetch="none" data-testid="clo-to-index">
        Index
      </Link>
    </div>
  );
}

function LocaleNote() {
  return (
    <article data-testid="clo-note">{`note:${useParams().noteId}`}</article>
  );
}

function LocaleNoteModal() {
  return (
    <dialog open data-testid="clo-note-modal">
      {`modal:${useParams().noteId}`}
    </dialog>
  );
}

export default clientUrls(({ layout, path, loader, loading, intercept }) => [
  layout(LocaleLayout, () => [
    path("/", LocaleIndex, { name: "index" }),
    path("/items/:itemId", LocaleItem, { name: "item" }, () => [
      loader(ClientLocaleItemLoader),
      loading(<LocaleItemLoading />),
    ]),
    path("/notes/:noteId", LocaleNote, { name: "note" }),
    intercept("@modal", ".note", LocaleNoteModal),
  ]),
]);
