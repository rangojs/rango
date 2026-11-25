"use client";

import { useEffect, useRef, useState } from "react";
import {
  clientUrls,
  Link,
  Outlet,
  useKept,
  useKeptShow,
  usePathname,
} from "@rangojs/router/client";

// <Outlet keep /> fixture: server pages under a keeping server layout
// (kept-pages.tsx) and a clientUrls() group whose layout keeps.
// Body: tests/shared-e2e/src/kept-pages-scenario.ts.

type KeptWindow = { __keepLog?: string[] };

function log(line: string): void {
  ((window as KeptWindow).__keepLog ??= []).push(line);
}

const ENTRANCE_CSS =
  ".kept-enter{opacity:1;transition:opacity 2s}" +
  "@starting-style{.kept-enter{opacity:0}}";

export function KeptPage({ id }: { id: string }) {
  const pathname = usePathname();
  const { hidden } = useKept();
  const [count, setCount] = useState(0);
  const once = useRef(false);
  useEffect(() => {
    log(`effect ${id}${once.current ? " again" : ""}`);
    once.current = true;
  }, [id]);
  useKeptShow(() => log(`show ${id}`));
  return (
    <section
      data-testid={`kept-${id}`}
      data-path={pathname}
      data-hidden={String(hidden)}
    >
      <style>{ENTRANCE_CSS}</style>
      <h2>{`page ${id}`}</h2>
      <div
        data-testid={`kept-strip-${id}`}
        style={{ overflowX: "auto", width: 200 }}
      >
        <div style={{ width: 2000, height: 20 }} />
      </div>
      <input data-testid={`kept-input-${id}`} />
      <button
        type="button"
        data-testid={`kept-count-${id}`}
        onClick={() => setCount((value) => value + 1)}
      >
        {count}
      </button>
      <p data-testid={`kept-enter-${id}`} className="kept-enter">
        entrance
      </p>
    </section>
  );
}

/**
 * Passes `keep` on the server only: the browser hydrates a plain outlet over
 * the keeping outlet's HTML. (The other way round, React 19.3 never finishes
 * hydrating a visible Activity over HTML without its marker: the tab hangs.)
 */
export function KeptDriftOutlet() {
  return (
    <Outlet keep={typeof window === "undefined" ? { max: 1 } : undefined} />
  );
}

function GroupShell() {
  return (
    <div data-testid="kept-group">
      <nav>
        <Link to="/kept-pages-group/x" data-testid="kept-group-to-x">
          x
        </Link>
        <Link to="/kept-pages-group/y" data-testid="kept-group-to-y">
          y
        </Link>
      </nav>
      <Outlet keep={{ max: 1 }} />
    </div>
  );
}

function GroupPageX() {
  return <KeptPage id="x" />;
}

function GroupPageY() {
  return <KeptPage id="y" />;
}

export default clientUrls(({ layout, path }) => [
  layout(GroupShell, () => [path("/x", GroupPageX), path("/y", GroupPageY)]),
]);
