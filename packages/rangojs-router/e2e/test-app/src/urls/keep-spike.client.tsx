"use client";

import {
  Suspense,
  startTransition,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Breadcrumbs,
  Link,
  Meta,
  Outlet,
  useHandle,
  useLoader,
  useNavigation,
  usePathname,
  usePushHandle,
  useSearchParams,
} from "@rangojs/router/client";
import {
  KeepSpikeALoader,
  KeepSpikeBLoader,
  KeepSpikeCLoader,
} from "./keep-spike.loaders.js";
import { keepSpikeAct } from "./keep-spike.actions.js";

// SPIKE (kept pages, part C): three pages under a layout whose Outlet keeps
// left pages (`keep`) or not. Every value a frame should agree on is a data
// attribute, read per frame by e2e/keep-pages-frames.test.ts.

type KeepSpikePageName = "a" | "b" | "c";

const LOADERS = {
  a: KeepSpikeALoader,
  b: KeepSpikeBLoader,
  c: KeepSpikeCLoader,
} as const;

/** Instances mounted per variant and page, in this document. */
const instances = new Map<string, number>();

function PageData({ page }: { page: KeepSpikePageName }) {
  const { data } = useLoader(LOADERS[page]);
  return <p data-ks-data={data}>{data}</p>;
}

export function KeepSpikePage({
  variant,
  page,
}: {
  variant: string;
  page: KeepSpikePageName;
}) {
  // Numbered at its first commit, so a render React threw away takes no
  // number. A show after a hide runs this layout effect again on the same
  // instance and keeps its number; only a new instance takes the next one.
  const [instance] = useState<{ n: number }>(() => ({ n: 0 }));
  const sectionRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (instance.n === 0) {
      const key = `${variant}:${page}`;
      instance.n = (instances.get(key) ?? 0) + 1;
      instances.set(key, instance.n);
    }
    sectionRef.current?.setAttribute("data-ks-inst", String(instance.n));
  });
  const pathname = usePathname();
  const [search] = useSearchParams();
  const nav = useNavigation((state) => state.state);
  const pushTitle = usePushHandle(Meta);
  const pushCrumb = usePushHandle(Breadcrumbs);
  pushTitle({ title: `KS ${page}` });
  pushCrumb({ label: page, href: `/keep-spike/${variant}/${page}` });
  return (
    <section
      ref={sectionRef}
      data-ks-page={page}
      data-ks-inst={instance.n}
      data-ks-path={pathname}
      data-ks-search={search.toString()}
      data-ks-nav={nav}
    >
      <h2>Page {page.toUpperCase()}</h2>
      <Suspense fallback={<p data-ks-fallback={page}>loading {page}</p>}>
        <PageData page={page} />
      </Suspense>
    </section>
  );
}

function lastTitle(descriptors: readonly unknown[]): string {
  for (let i = descriptors.length - 1; i >= 0; i--) {
    const title = (descriptors[i] as { title?: unknown }).title;
    if (typeof title === "string") return title;
  }
  return "";
}

export function KeepSpikeLayout({
  variant,
  keep,
}: {
  variant: string;
  keep: boolean;
}) {
  const pathname = usePathname();
  const nav = useNavigation((state) => state.state);
  const title = lastTitle(useHandle(Meta));
  const crumbs = useHandle(Breadcrumbs)
    .filter((crumb) => crumb.href.startsWith("/keep-spike/"))
    .map((crumb) => crumb.label)
    .join(",");
  const [acting, setActing] = useState(false);
  const base = `/keep-spike/${variant}`;
  return (
    <div data-testid="ks-layout">
      <header
        data-ks-chrome={variant}
        data-ks-path={pathname}
        data-ks-nav={nav}
        data-ks-title={title}
        data-ks-crumbs={crumbs}
      >
        <Link to={`${base}/a`} prefetch="none" data-testid="ks-to-a">
          A
        </Link>
        <Link to={`${base}/b?from=a`} prefetch="none" data-testid="ks-to-b">
          B
        </Link>
        {/* SPIKE (part D, H4): B with no search, so a link back to A
            changes neither params nor search. */}
        <Link to={`${base}/b`} prefetch="none" data-testid="ks-to-b-bare">
          B bare
        </Link>
        <Link to={`${base}/c?from=b`} prefetch="none" data-testid="ks-to-c">
          C
        </Link>
        <button
          data-testid="ks-act"
          data-acting={String(acting)}
          onClick={() => {
            setActing(true);
            startTransition(async () => {
              await keepSpikeAct(variant);
              setActing(false);
            });
          }}
        >
          Act
        </button>
      </header>
      {keep ? <Outlet keep={{ max: 1 }} /> : <Outlet />}
    </div>
  );
}
