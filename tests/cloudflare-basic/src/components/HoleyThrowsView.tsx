"use client";

import { Suspense, use, type ReactNode } from "react";
import {
  Link,
  Outlet,
  useHandle,
  useLoader,
  useLocationState,
  useNavigation,
  usePathname,
} from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import { HoleyShellNotes, HoleyShellState } from "./holey-shell.js";

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

// dc-t93 fixtures: reads with no <Suspense> above them, so a failure on a
// document load fails React's server-render shell.
export function HoleyShellReader({
  loader,
}: {
  loader: LoaderDefinition<string>;
}): ReactNode {
  const { data } = useLoader(loader);
  return <p data-testid="holey-shell-data">{data}</p>;
}

// Throws only while it renders on the server: the browser alone renders it.
export function HoleyShellSsrThrower(): ReactNode {
  if (typeof window === "undefined") {
    throw new Error("holey-shell-ssr-only-error");
  }
  return <p data-testid="holey-shell-client-rendered">client rendered</p>;
}

export function HoleyShellTarget(): ReactNode {
  const state = useLocationState(HoleyShellState);
  return (
    <main data-testid="holey-shell-target">
      <p data-testid="holey-shell-target-state">{state?.text ?? "none"}</p>
    </main>
  );
}

// Every reader shape the hook contract names, in one component.
export function HoleyShellHooks(): ReactNode {
  const pathname = usePathname();
  const navigation = useNavigation();
  const state = useLocationState(HoleyShellState);
  const notes = useHandle(HoleyShellNotes) ?? [];
  return (
    <section data-testid="holey-shell-hooks">
      <p data-testid="holey-shell-pathname">{pathname}</p>
      <p data-testid="holey-shell-nav-state">{navigation.state}</p>
      <p data-testid="holey-shell-location-state">{state?.text ?? "none"}</p>
      <p data-testid="holey-shell-notes">{notes.join(",")}</p>
      <Link
        to="/holey-throws/shell-target"
        data-testid="holey-shell-hooks-away"
      >
        away
      </Link>
    </section>
  );
}

const SHELL_CASES = [
  "shell-loader",
  "shell-loader-bounded",
  "shell-not-found",
  "shell-redirect",
  "shell-redirect-state",
  "shell-ppr",
  "shell-ssr-throw",
  "shell-ssr-throw-bounded",
  "shell-hooks",
] as const;

// The start of the client navigations the document loads are compared with.
export function HoleyShellIndex(): ReactNode {
  return (
    <main data-testid="holey-shell-index">
      {SHELL_CASES.map((name) => (
        <Link
          key={name}
          to={`/holey-throws/${name}`}
          data-testid={`holey-shell-link-${name}`}
        >
          {name}
        </Link>
      ))}
    </main>
  );
}
