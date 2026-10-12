"use client";

import type { ReactNode } from "react";
import { Suspense } from "react";
import { clientUrls, useLoader } from "@rangojs/router/client";
import { ClientUrlsElementLoader } from "./client-urls-loader-element.defs.js";

// A no-script document of a group route whose inline <Suspense> draws a
// client component from a loader's answer
// (client-urls-loader-element.test.ts, body in tests/shared-e2e).

function ClientUrlsElementRead(): ReactNode {
  const { data } = useLoader(ClientUrlsElementLoader);
  return <div data-testid="cle-content">{data.badge}</div>;
}

function ClientUrlsElementPage(): ReactNode {
  return (
    <section data-testid="cle-page">
      <Suspense fallback={<p data-testid="cle-fallback">Loading the badge</p>}>
        <ClientUrlsElementRead />
      </Suspense>
    </section>
  );
}

export default clientUrls(({ path, loader }) => [
  path("/", ClientUrlsElementPage, { name: "index" }, () => [
    loader(ClientUrlsElementLoader),
  ]),
]);
