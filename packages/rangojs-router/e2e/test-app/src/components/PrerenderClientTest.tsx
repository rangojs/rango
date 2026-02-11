"use client";

import { useLoader, useLocationState, useAction, type LoaderDefinition } from "@rangojs/router/client";
import { PrerenderTestLocationState } from "../location-states.js";
import { prerenderTestAction } from "../actions.js";

interface PrerenderTestLoaderData {
  test: boolean;
  message: string;
}

interface PrerenderClientTestProps {
  loader: LoaderDefinition<PrerenderTestLoaderData>;
}

export function PrerenderClientTest({ loader }: PrerenderClientTestProps) {
  const { data } = useLoader<PrerenderTestLoaderData>(loader);
  const locationState = useLocationState(PrerenderTestLocationState);
  const actionState = useAction(prerenderTestAction);

  return (
    <div data-testid="prerender-client-test">
      <p data-testid="prerender-loader-data">{data.message}</p>
      <p data-testid="prerender-loader-test">{String(data.test)}</p>
      {locationState?.tag && (
        <p data-testid="prerender-location-state">{locationState.tag}</p>
      )}
      <p data-testid="prerender-action-state">{actionState.state}</p>
      <pre data-testid="prerender-loader-json">{JSON.stringify(loader)}</pre>
      <pre data-testid="prerender-action-id">{String((prerenderTestAction as any)?.$$id ?? "no-action-id")}</pre>
      <pre data-testid="prerender-location-state-key">{(PrerenderTestLocationState as any).__rsc_ls_key || "no-ls-key"}</pre>
    </div>
  );
}
