"use client";

import type { ReactNode } from "react";
import { clientUrls, Link, useLoader, useOutlet } from "@rangojs/router/client";
import { clientUrlsResultAction } from "./actions.js";
import {
  ClientUrlsIsActionNsLoader,
  ClientUrlsModalNoteLoader,
  ClientUrlsModalResultLoader,
} from "./loader.js";
import { onResultOk } from "./predicates.js";

/**
 * A clientUrls() group with a module-local intercept: from the group's index,
 * /note/:noteId opens in the @modal slot of the group's layout. The modal's
 * loaders take the route options: a revalidate() the build moves to the
 * server (onResultOk reads the action's result), and prefetch: false.
 * ClientUrlsIsActionNsLoader re-runs on every action of actions.ts: its new
 * value marks an action's commit.
 */
function InterceptLayout(): ReactNode {
  const { content } = useOutlet();
  return <section data-testid="cui-layout">{content}</section>;
}

function InterceptIndex(): ReactNode {
  return (
    <div data-testid="cui-index">
      <Link
        to="/__client-urls-intercept/note/a"
        prefetch="none"
        data-testid="cui-note-link"
      >
        Open note
      </Link>
      <Link
        to="/__client-urls-intercept/note/b"
        prefetch="hover"
        data-testid="cui-note-prefetch-link"
      >
        Open note (prefetched)
      </Link>
    </div>
  );
}

function NotePage(): ReactNode {
  return <article data-testid="cui-note-page">note</article>;
}

function NoteModal(): ReactNode {
  const { data: ns } = useLoader(ClientUrlsIsActionNsLoader);
  const { data: result } = useLoader(ClientUrlsModalResultLoader);
  const { data: note } = useLoader(ClientUrlsModalNoteLoader);
  return (
    <div role="dialog" data-testid="cui-modal">
      <span data-testid="cui-modal-ns-runs">{ns.runs}</span>
      <span data-testid="cui-modal-result-runs">{result.runs}</span>
      <span data-testid="cui-modal-note-runs">{note.runs}</span>
      <button
        data-testid="cui-modal-ok"
        onClick={() => void clientUrlsResultAction(true)}
      >
        Succeeds
      </button>
      <button
        data-testid="cui-modal-fail"
        onClick={() => void clientUrlsResultAction(false)}
      >
        Fails
      </button>
    </div>
  );
}

export default clientUrls(({ layout, path, loader, intercept, revalidate }) => [
  layout(InterceptLayout, () => [
    path("/", InterceptIndex, { name: "index" }),
    path("/note/:noteId", NotePage, { name: "note" }),
    intercept("@modal", ".note", NoteModal, () => [
      loader(ClientUrlsIsActionNsLoader),
      loader(ClientUrlsModalResultLoader, () => [revalidate(onResultOk)]),
      loader(ClientUrlsModalNoteLoader, { prefetch: false }),
    ]),
  ]),
]);
