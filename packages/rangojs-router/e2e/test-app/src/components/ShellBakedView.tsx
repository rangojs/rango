"use client";

import { Suspense, use } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { ShellBakedNavData } from "../urls/shell-cache.defs.js";

function NestedValue({ promise }: { promise: Promise<string> }) {
  const value = use(promise);
  return <div data-testid="shell-baked-nested">{value}</div>;
}

function SiblingValue({ loader }: { loader: LoaderDefinition<string> }) {
  const { data } = useLoader(loader);
  return <div data-testid="shell-baked-sibling">{data}</div>;
}

/**
 * stream:"navigation" bake pin. The flagged loader's read settles at capture
 * (bake lane), so `title` renders as SHELL material. The nested promise and
 * the plain sibling read each sit under their OWN Suspense — a masked reader
 * must never share the baked material's nearest boundary, or the whole
 * boundary postpones and the baked value lands in the hole instead of the
 * prelude.
 */
export function ShellBakedView({
  navLoader,
  siblingLoader,
}: {
  navLoader: LoaderDefinition<ShellBakedNavData>;
  siblingLoader: LoaderDefinition<string>;
}) {
  const { data } = useLoader(navLoader);
  return (
    <section data-testid="shell-baked">
      <div data-testid="shell-baked-title">{data.title}</div>
      <Suspense
        fallback={<div data-testid="shell-baked-nested-fallback">nested…</div>}
      >
        <NestedValue promise={data.slow} />
      </Suspense>
      <Suspense
        fallback={
          <div data-testid="shell-baked-sibling-fallback">sibling…</div>
        }
      >
        <SiblingValue loader={siblingLoader} />
      </Suspense>
    </section>
  );
}

/** The loading()-less fully-baked route: a single flagged loader, no masks. */
export function ShellBakedOnlyView({
  loader,
}: {
  loader: LoaderDefinition<string>;
}) {
  const { data } = useLoader(loader);
  return <div data-testid="shell-baked-only">{data}</div>;
}
