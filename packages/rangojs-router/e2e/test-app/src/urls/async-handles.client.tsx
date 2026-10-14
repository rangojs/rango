"use client";

import {
  Breadcrumbs,
  Meta,
  useHandle,
  usePathname,
} from "@rangojs/router/client";
import { useEffect } from "react";

// The fixture's own crumbs only: the app's root layout pushes its own.
export function AhTrail() {
  const crumbs = useHandle(Breadcrumbs).filter((crumb) =>
    crumb.href.startsWith("/async-handles"),
  );
  return (
    <ol data-testid="ah-trail">
      {crumbs.map((crumb) => (
        <li key={crumb.href} data-testid="ah-crumb">
          {crumb.label}
        </li>
      ))}
    </ol>
  );
}

type Views = Record<string, unknown>[];

function record(key: string, entry: Record<string, unknown>): void {
  const w = window as unknown as Record<string, Views>;
  (w[key] ??= []).push(entry);
}

function useTitle(): string | undefined {
  const descriptors = useHandle(Meta) as readonly Record<string, unknown>[];
  const title = descriptors.find((d) => "title" in d)?.title;
  if (typeof title === "string") return title;
  return (title as { absolute?: string } | undefined)?.absolute;
}

// Documented pattern: an effect keyed on the handle value reads the resolved
// title, never a stale one.
export function AhTitleEffect() {
  const title = useTitle();
  useEffect(() => {
    if (title) record("__titleViews", { title, doc: document.title });
  }, [title]);
  return null;
}

// Recorded, not pinned: an effect keyed on [pathname, title] fires on the
// pathname change (with the held title) and again when the title lands.
export function AhPathTitleEffect() {
  const pathname = usePathname();
  const title = useTitle();
  useEffect(() => {
    if (title) record("__pathTitleViews", { pathname, title });
  }, [pathname, title]);
  return null;
}
