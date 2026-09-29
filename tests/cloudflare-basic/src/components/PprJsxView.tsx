"use client";

import { Suspense } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { PprJsxData } from "../loaders/ppr-jsx.js";

export function PprJsxView({
  loader,
}: {
  loader: LoaderDefinition<PprJsxData>;
}) {
  const { data } = useLoader(loader);
  return (
    <div data-testid="ppr-jsx">
      <h1 data-testid="ppr-jsx-title">{data.title}</h1>
      {data.related}
      {data.live}
      <Suspense
        fallback={
          <p data-testid="ppr-jsx-reviews-fallback">reviews pending...</p>
        }
      >
        {data.reviews}
      </Suspense>
    </div>
  );
}
