"use client";

import { useState } from "react";
import {
  clientUrls,
  Meta,
  useLoader,
  usePushHandle,
} from "@rangojs/router/client";
import { PushHandleTitle } from "./push-handle.client.js";
import { PushHandleGroupLoader } from "./push-handle.loaders.js";

/**
 * A clientUrls group page: its loader pushes the title from its data on the
 * server; the component pushes a draft name the client holds, which shows
 * after the loader's title while it is set.
 */
function PushHandleGroupPage() {
  const { data, load } = useLoader(PushHandleGroupLoader);
  const [draft, setDraft] = useState("");
  const pushTitle = usePushHandle(Meta);
  if (draft) pushTitle({ title: `PHG ${draft}` });
  return (
    <section data-testid="phg-page">
      <PushHandleTitle testId="phg-title" />
      <p data-testid="phg-name">{data.name}</p>
      <button data-testid="phg-rename" onClick={() => setDraft("Draft")}>
        Rename
      </button>
      <button data-testid="phg-clear" onClick={() => setDraft("")}>
        Clear
      </button>
      <button data-testid="phg-load" onClick={() => load().catch(() => {})}>
        Load
      </button>
    </section>
  );
}

export default clientUrls(({ path, loader }) => [
  path("/", PushHandleGroupPage, { name: "index" }, () => [
    loader(PushHandleGroupLoader),
  ]),
]);
