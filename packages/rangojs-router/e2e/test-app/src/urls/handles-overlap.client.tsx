"use client";

import {
  Breadcrumbs,
  useHandle,
  usePathname,
  type BreadcrumbItem,
} from "@rangojs/router/client";
import { Suspense, use, type ReactNode } from "react";

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
}: {
  crumb: BreadcrumbItem | undefined;
  path?: string;
}) {
  return (
    <nav data-testid="ho-trail" data-path={path}>
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
  const path = usePathname();
  return <Trail crumb={crumb} path={path} />;
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
