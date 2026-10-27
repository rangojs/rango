"use client";

import {
  Breadcrumbs,
  useHandle,
  usePathname,
  useSegments,
  type BreadcrumbItem,
} from "@rangojs/router/client";
import { Suspense, use, useEffect, type ReactNode } from "react";

export const HO_CRUMB_HREF = "/handles-overlap/crumb";

function CrumbContent({
  content,
}: {
  content: ReactNode | Promise<ReactNode>;
}) {
  return <>{content instanceof Promise ? use(content) : content}</>;
}

// The content <Suspense> is not keyed: it stays revealed across pages, and a
// pending content suspends it again.
function Trail({
  crumb,
  path,
  segments,
}: {
  crumb: BreadcrumbItem | undefined;
  path?: string;
  segments?: string;
}) {
  return (
    <nav data-testid="ho-trail" data-path={path} data-segments={segments}>
      <span data-testid="ho-crumb">{crumb?.label}</span>
      <Suspense fallback={<span data-testid="ho-crumb-fallback">loading</span>}>
        <span data-testid="ho-crumb-content">
          {crumb?.content ? <CrumbContent content={crumb.content} /> : null}
        </span>
      </Suspense>
    </nav>
  );
}

const ours = (crumbs: BreadcrumbItem[]) =>
  crumbs.find((crumb) => crumb.href === HO_CRUMB_HREF);

function MultiTrail() {
  const crumb = ours(useHandle(Breadcrumbs));
  const segments = useSegments((s) => s.path.join("/"));
  const path = usePathname();
  // Every committed pair, for the e2e (window.__hoEffects).
  useEffect(() => {
    const w = window as unknown as {
      __hoEffects?: { path: string; segments: string }[];
    };
    (w.__hoEffects ??= []).push({ path, segments });
  }, [path, segments]);
  return <Trail crumb={crumb} path={path} segments={segments} />;
}

function FullTrail() {
  return <Trail crumb={ours(useHandle(Breadcrumbs))} />;
}

function SelectTrail() {
  return <Trail crumb={useHandle(Breadcrumbs, ours)} />;
}

export function HoTrail({ reader }: { reader: "multi" | "full" | "select" }) {
  if (reader === "multi") return <MultiTrail />;
  if (reader === "full") return <FullTrail />;
  return <SelectTrail />;
}
