"use client";

import { useLoader, type LoaderDefinition } from "@rangojs/router/client";
import type { MwChainLoaderData } from "../loaders.js";

export function MwChainClientDisplay({
  loader,
  testIdPrefix = "loader",
}: {
  loader: LoaderDefinition<MwChainLoaderData>;
  testIdPrefix?: string;
}) {
  const { data } = useLoader<MwChainLoaderData>(loader);

  return (
    <div>
      <span data-testid={`${testIdPrefix}-global-cookie`}>
        {data.globalCookie ?? "none"}
      </span>
      <span data-testid={`${testIdPrefix}-action-cookie`}>
        {data.actionCookie ?? "none"}
      </span>
      <span data-testid={`${testIdPrefix}-route-cookie`}>
        {data.routeCookie ?? "none"}
      </span>
    </div>
  );
}

export function MwChainParallelClientDisplay({
  loader,
}: {
  loader: LoaderDefinition<MwChainLoaderData>;
}) {
  const { data } = useLoader<MwChainLoaderData>(loader);

  return (
    <div>
      <span data-testid="parallel-global-cookie">
        {data.globalCookie ?? "none"}
      </span>
      <span data-testid="parallel-action-cookie">
        {data.actionCookie ?? "none"}
      </span>
      <span data-testid="parallel-route-cookie">
        {data.routeCookie ?? "none"}
      </span>
    </div>
  );
}

export function MwChainInterceptClientDisplay({
  loader,
}: {
  loader: LoaderDefinition<MwChainLoaderData>;
}) {
  const { data } = useLoader<MwChainLoaderData>(loader);

  return (
    <div>
      <span data-testid="intercept-loader-global-cookie">
        {data.globalCookie ?? "none"}
      </span>
      <span data-testid="intercept-loader-action-cookie">
        {data.actionCookie ?? "none"}
      </span>
      <span data-testid="intercept-loader-route-cookie">
        {data.routeCookie ?? "none"}
      </span>
    </div>
  );
}
