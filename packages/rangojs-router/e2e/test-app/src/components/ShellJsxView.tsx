"use client";

import { Suspense } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { ShellJsxData } from "../urls/shell-cache-jsx.js";

export function ShellJsxView({
  loader,
}: {
  loader: LoaderDefinition<ShellJsxData>;
}) {
  const { data } = useLoader(loader);
  return (
    <div data-testid="shell-jsx">
      <h1 data-testid="shell-jsx-title">{data.title}</h1>
      {data.related}
      {data.live}
      <Suspense
        fallback={
          <p data-testid="shell-jsx-reviews-fallback">reviews pending...</p>
        }
      >
        {data.reviews}
      </Suspense>
    </div>
  );
}
