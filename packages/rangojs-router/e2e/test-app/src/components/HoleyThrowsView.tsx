"use client";

import { Suspense, use, type ReactNode } from "react";
import { Outlet, useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";

export interface HoleyThrowsData {
  baked: string;
  live: Promise<string>;
}

function Live({ promise }: { promise: Promise<string> }) {
  return <span data-testid="holey-live">{use(promise)}</span>;
}

// dc-t92 fixture: the layout marks whether the layouts survive a failure.
export function HoleyThrowsLayout(): ReactNode {
  return (
    <div data-testid="holey-layout">
      <Outlet />
    </div>
  );
}

// The baked value, and the live hole under its own <Suspense>.
export function HoleyThrowsView({
  loader,
}: {
  loader: LoaderDefinition<HoleyThrowsData>;
}) {
  const { data } = useLoader(loader);
  return (
    <section data-testid="holey-view">
      <p data-testid="holey-baked">{data.baked}</p>
      <Suspense
        fallback={<span data-testid="holey-live-fallback">live-pending</span>}
      >
        <Live promise={data.live} />
      </Suspense>
    </section>
  );
}
