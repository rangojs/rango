"use client";

import { useLayoutEffect, ViewTransition, type ReactNode } from "react";
import {
  Link,
  useAction,
  useLinkStatus,
  useLoader,
} from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import { optimisticSettleSave } from "../actions/optimistic-settle.js";

/**
 * /opt-settle/* probes (tests/shared-e2e/src/optimistic-settle-scenario.ts).
 * - window.__optSettleLog: every commit of a link spinner,
 *   "<link>:<pending|idle>:<page on screen>".
 * - window.__optSettleVt: every commit that animates the page's push-keyed
 *   <ViewTransition>, "<event>:<page>:<types>".
 */

function onScreen(): string {
  if (document.querySelector('[data-testid="opt-settle-skeleton"]')) {
    return "skeleton";
  }
  if (document.querySelector('[data-testid="opt-settle-error"]')) {
    return "error";
  }
  return (
    document.querySelector('[data-testid="opt-settle-page"]')?.textContent ??
    "-"
  );
}

function Spinner({ id }: { id: string }): ReactNode {
  const { pending } = useLinkStatus();
  useLayoutEffect(() => {
    const w = window as unknown as { __optSettleLog?: string[] };
    (w.__optSettleLog ??= []).push(
      `${id}:${pending ? "pending" : "idle"}:${onScreen()}`,
    );
  });
  return (
    <span data-testid={`opt-settle-spinner-${id}`}>{pending ? "…" : ""}</span>
  );
}

function SaveButton(): ReactNode {
  const state = useAction(optimisticSettleSave, (s) => s.state);
  return (
    <button
      type="button"
      data-testid="opt-settle-save"
      onClick={() => void optimisticSettleSave()}
    >
      {`save:${state}`}
    </button>
  );
}

const LINKS: { to: string; id: string; spinner: boolean }[] = [
  { to: "2", id: "2", spinner: true },
  { to: "3", id: "3", spinner: true },
  { to: "4", id: "4", spinner: false },
  { to: "r", id: "r", spinner: true },
  { to: "f", id: "f", spinner: true },
];

export function OptimisticSettleShell({
  base,
  children,
}: {
  base: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div data-testid="opt-settle-shell">
      <nav>
        {LINKS.map(({ to, id, spinner }) => (
          <Link
            key={id}
            to={`${base}/${to}`}
            prefetch="none"
            data-testid={`opt-settle-to-${id}`}
          >
            {id}
            {spinner && <Spinner id={id} />}
          </Link>
        ))}
      </nav>
      <SaveButton />
      {children}
    </div>
  );
}

function record(event: string, page: string) {
  return (_instance: unknown, types: readonly string[]): void => {
    const w = window as unknown as { __optSettleVt?: string[] };
    (w.__optSettleVt ??= []).push(`${event}:${page}:${types.join(",")}`);
  };
}

/** The page: it suspends until its loader's data streams in. */
export function OptimisticSettlePage({
  loader,
}: {
  loader: LoaderDefinition<string>;
}): ReactNode {
  const { data: id } = useLoader(loader);
  return (
    <ViewTransition
      default={{ push: "opt-settle-push", default: "none" }}
      onEnter={record("enter", id)}
      onUpdate={record("update", id)}
    >
      <p data-testid="opt-settle-page">{id}</p>
    </ViewTransition>
  );
}
