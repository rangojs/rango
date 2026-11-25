"use client";

import { Suspense, useLayoutEffect, useRef, useState } from "react";
import {
  Breadcrumbs,
  Link,
  Meta,
  Outlet,
  useHandle,
  useLoader,
  useNavigation,
  useParams,
  usePathname,
  usePushHandle,
  useSearchParams,
} from "@rangojs/router/client";
import {
  KnA1Loader,
  KnA2Loader,
  KnA3Loader,
  KnB1Loader,
  KnB2Loader,
  KnB3Loader,
  KnC1Loader,
  KnD1Loader,
} from "./keep-nested.loaders.js";

// SPIKE (kept pages, part E): an outer layout whose Outlet keeps two left
// sections, over section layouts whose Outlets keep two left pages each.
// Every value a frame should agree on is a data attribute, read per frame by
// e2e/keep-nested-frames.test.ts.

export type KnPageName = "a1" | "a2" | "a3" | "b1" | "b2" | "b3" | "c1" | "d1";
export type KnSectionName = "a" | "b" | "c" | "d";

const LOADERS = {
  a1: KnA1Loader,
  a2: KnA2Loader,
  a3: KnA3Loader,
  b1: KnB1Loader,
  b2: KnB2Loader,
  b3: KnB3Loader,
  c1: KnC1Loader,
  d1: KnD1Loader,
} as const;

const PAGES: readonly KnPageName[] = [
  "a1",
  "a2",
  "a3",
  "b1",
  "b2",
  "b3",
  "c1",
  "d1",
];

/** Instances mounted per variant and component, in this document. */
const instances = new Map<string, number>();

/**
 * Numbered at its first commit, so a render React threw away takes no
 * number. A show after a hide runs the layout effect again on the same
 * instance and keeps its number.
 */
function useInstance<T extends HTMLElement>(id: string, attribute: string) {
  const [instance] = useState<{ n: number }>(() => ({ n: 0 }));
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (instance.n === 0) {
      instance.n = (instances.get(id) ?? 0) + 1;
      instances.set(id, instance.n);
      const w = window as unknown as { __knMounts?: number };
      w.__knMounts = (w.__knMounts ?? 0) + 1;
    }
    ref.current?.setAttribute(attribute, String(instance.n));
  });
  return { n: instance.n, ref };
}

function PageData({ page }: { page: KnPageName }) {
  const { data } = useLoader(LOADERS[page]);
  return <p data-kn-data={data}>{data}</p>;
}

export function KnPage({
  variant,
  page,
}: {
  variant: string;
  page: KnPageName;
}) {
  const { n, ref } = useInstance<HTMLElement>(
    `${variant}:p:${page}`,
    "data-kn-inst",
  );
  const pathname = usePathname();
  const [search] = useSearchParams();
  const params = useParams();
  const nav = useNavigation((state) => state.state);
  const pushTitle = usePushHandle(Meta);
  const pushCrumb = usePushHandle(Breadcrumbs);
  pushTitle({ title: `KN ${page}` });
  pushCrumb({ label: page, href: `/keep-nested/${variant}/page/${page}` });
  return (
    <section
      ref={ref}
      data-kn-page={page}
      data-kn-inst={n}
      data-kn-path={pathname}
      data-kn-search={search.toString()}
      data-kn-params={JSON.stringify(params)}
      data-kn-nav={nav}
    >
      <h3>Page {page}</h3>
      <Suspense fallback={<p data-kn-fallback={page}>loading {page}</p>}>
        <PageData page={page} />
      </Suspense>
    </section>
  );
}

export function KnSection({
  variant,
  section,
}: {
  variant: string;
  section: KnSectionName;
}) {
  const { n, ref } = useInstance<HTMLDivElement>(
    `${variant}:s:${section}`,
    "data-kn-sinst",
  );
  const pathname = usePathname();
  const pushCrumb = usePushHandle(Breadcrumbs);
  pushCrumb({
    label: section.toUpperCase(),
    href: `/keep-nested/${variant}/section/${section}`,
  });
  return (
    <div
      ref={ref}
      data-kn-section={section}
      data-kn-sinst={n}
      data-kn-spath={pathname}
    >
      <h2>Section {section.toUpperCase()}</h2>
      <Outlet keep={{ max: 2 }} />
    </div>
  );
}

function lastTitle(descriptors: readonly unknown[]): string {
  for (let i = descriptors.length - 1; i >= 0; i--) {
    const title = (descriptors[i] as { title?: unknown }).title;
    if (typeof title === "string") return title;
  }
  return "";
}

export function KnOuter({ variant }: { variant: string }) {
  const pathname = usePathname();
  const nav = useNavigation((state) => state.state);
  const title = lastTitle(useHandle(Meta));
  const crumbs = useHandle(Breadcrumbs)
    .filter((crumb) => crumb.href.startsWith("/keep-nested/"))
    .map((crumb) => crumb.label)
    .join(",");
  const base = `/keep-nested/${variant}`;
  return (
    <div data-testid="kn-layout">
      <header
        data-kn-chrome={variant}
        data-kn-path={pathname}
        data-kn-nav={nav}
        data-kn-title={title}
        data-kn-crumbs={crumbs}
      >
        {PAGES.map((page) => (
          <Link
            key={page}
            to={`${base}/${page[0]}/${page[1]}`}
            prefetch="none"
            data-testid={`kn-to-${page}`}
          >
            {page}
          </Link>
        ))}
        {/* The same pages with a search, so a link back to a kept page
            changes its search: the server re-runs its route, and its URL
            hooks have a value to catch up to. */}
        {PAGES.map((page) => (
          <Link
            key={`${page}-q`}
            to={`${base}/${page[0]}/${page[1]}?q=back`}
            prefetch="none"
            data-testid={`kn-to-${page}-q`}
          >
            {page}?q
          </Link>
        ))}
      </header>
      <Outlet keep={{ max: 2 }} />
    </div>
  );
}
