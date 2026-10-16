"use client";

import type { ReactNode } from "react";
import { clientUrls, useLoader, useParams } from "@rangojs/router/client";
import { ClientUrlsDetailLoader } from "./loader.js";
import { onResultOk } from "./predicates.js";

// Mounted only by the async include of /__client-urls-lazy (urls.tsx), so the
// first request's route discovery is what loads it and registers its hoisted
// revalidate() (e2e/dev-rsc-reload.test.ts, #1186).

function LazyDetail(): ReactNode {
  const { slug } = useParams<{ slug: string }>();
  const { data } = useLoader(ClientUrlsDetailLoader);

  return (
    <section data-testid="client-urls-lazy">
      <p data-testid="client-urls-param">{slug}</p>
      <p data-testid="client-urls-loader">{data.slug}</p>
    </section>
  );
}

export default clientUrls(({ path, loader, revalidate }) => [
  path("/:slug", LazyDetail, () => [
    loader(ClientUrlsDetailLoader, () => [revalidate(onResultOk)]),
  ]),
]);
