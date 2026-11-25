"use client";

import { Suspense, useLayoutEffect, useRef, useState } from "react";
import {
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
import { Breadcrumbs } from "@/handles/breadcrumbs.js";
import {
  KeepLabALoader,
  KeepLabBLoader,
  KeepLabCLoader,
} from "./keep-lab.loaders.js";
import {
  KEEP_LAB_PAGES,
  keepLabModeInfo,
  type KeepLabMode,
  type KeepLabPageName,
} from "./keep-lab.modes.js";

// SPIKE (keep lab): the layout and the pages every mode shares. Every value
// a screen should agree on is also a data attribute, for the recording script
// (scripts/record-keep-lab.mjs).

const LOADERS = {
  a: KeepLabALoader,
  b: KeepLabBLoader,
  c: KeepLabCLoader,
} as const;

/** Instances mounted per mode and page, in this document. */
const instances = new Map<string, number>();

function PageData({ page }: { page: KeepLabPageName }) {
  const { data } = useLoader(LOADERS[page]);
  return (
    <p data-kl-data={`${data.page}:${data.read}`} style={dataStyle}>
      Read <strong>#{data.read}</strong> at {data.at}
    </p>
  );
}

function PageSkeleton({ page }: { page: KeepLabPageName }) {
  return (
    <p data-kl-skeleton={page} style={{ ...dataStyle, ...skeletonStyle }}>
      Loading page {page.toUpperCase()}...
    </p>
  );
}

export function KeepLabPage({
  mode,
  page,
}: {
  mode: KeepLabMode;
  page: KeepLabPageName;
}) {
  // Numbered at its first commit, so a render React threw away (StrictMode
  // included) takes no number. A show after a hide keeps the number; only a
  // new instance takes the next one.
  const [instance] = useState<{ n: number }>(() => ({ n: 0 }));
  const instanceRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (instance.n === 0) {
      const key = `${mode}:${page}`;
      instance.n = (instances.get(key) ?? 0) + 1;
      instances.set(key, instance.n);
    }
    if (instanceRef.current) {
      // React renders no children here, so it never overwrites this text.
      instanceRef.current.textContent = `#${instance.n}`;
    }
  });
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [search] = useSearchParams();
  const pushTitle = usePushHandle(Meta);
  const pushCrumb = usePushHandle(Breadcrumbs);
  const name = page.toUpperCase();
  pushTitle({ title: `Keep lab ${mode}: page ${name}` });
  pushCrumb({ label: `Page ${name}`, href: `/keep-lab/${mode}/${page}` });

  return (
    <section data-kl-page={page} style={pageStyle}>
      <h2 style={{ margin: "0 0 0.5rem" }}>
        Page {name}{" "}
        <small style={{ color: "#888", fontWeight: "normal" }}>
          instance <span ref={instanceRef} data-kl-instance /> · URL {pathname}
          {search.size ? `?${search.toString()}` : ""}
        </small>
      </h2>
      <Suspense fallback={<PageSkeleton page={page} />}>
        <PageData page={page} />
      </Suspense>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <label style={boxStyle}>
          Type here: <input data-kl-input placeholder="survives a keep?" />
        </label>
        <div style={boxStyle}>
          <button data-kl-panel-toggle onClick={() => setOpen((v) => !v)}>
            {open ? "Close panel" : "Open panel"}
          </button>
          {open && (
            <p data-kl-panel style={{ margin: "0.5rem 0 0" }}>
              The panel is open (React state).
            </p>
          )}
        </div>
        <div
          data-kl-list
          style={{ ...boxStyle, height: 120, width: 180, overflowY: "auto" }}
        >
          {Array.from({ length: 40 }, (_, i) => (
            <div key={i}>
              Row {i + 1} of page {name}
            </div>
          ))}
        </div>
      </div>
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

function currentPage(pathname: string): string {
  return pathname.split("/").at(-1) || "lab";
}

export function KeepLabLayout({ mode }: { mode: KeepLabMode }) {
  const info = keepLabModeInfo(mode);
  const pathname = usePathname();
  const nav = useNavigation((state) => state.state);
  const title = lastTitle(useHandle(Meta));
  const base = `/keep-lab/${mode}`;
  const here = currentPage(pathname);

  return (
    <div data-kl-layout={mode}>
      <h1 style={{ marginBottom: 0 }}>
        Keep lab · {info.label}{" "}
        <Link to="/keep-lab" style={{ fontSize: "0.9rem" }}>
          all modes
        </Link>
      </h1>
      <p style={{ margin: "0.25rem 0" }}>{info.setup}</p>
      <p style={watchStyle}>
        <strong>Watch for:</strong> {info.watch}
      </p>
      <div style={navStyle}>
        <div>
          Links (prefetch on hover):{" "}
          {KEEP_LAB_PAGES.map((page) => (
            <Link
              key={page}
              to={`${base}/${page}`}
              prefetch="hover"
              style={linkStyle}
              data-kl-link={page}
            >
              {page.toUpperCase()}
            </Link>
          ))}
        </div>
        <div>
          With a search (re-runs the route):{" "}
          {KEEP_LAB_PAGES.map((page) => (
            <Link
              key={page}
              to={`${base}/${page}?from=${here}`}
              prefetch="hover"
              style={linkStyle}
              data-kl-link={`${page}-search`}
            >
              {page.toUpperCase()} ?from={here}
            </Link>
          ))}
        </div>
        <div>
          No prefetch:{" "}
          {KEEP_LAB_PAGES.map((page) => (
            <Link
              key={page}
              to={`${base}/${page}`}
              prefetch="none"
              style={linkStyle}
              data-kl-link={`${page}-noprefetch`}
            >
              {page.toUpperCase()}
            </Link>
          ))}
        </div>
        <div style={{ color: "#555" }}>
          navigation: <code data-kl-nav>{nav}</code> · title:{" "}
          <code data-kl-title>{title}</code>
        </div>
      </div>
      {mode === "keep" ? (
        <Outlet keep={{ max: 2 }} />
      ) : mode === "keep-two-step" ? (
        <Outlet keep={{ max: 2, reveal: "two-step" }} />
      ) : mode === "group" ? (
        <Outlet keep={{ max: 2, by: "route" }} />
      ) : (
        <Outlet />
      )}
    </div>
  );
}

const pageStyle = {
  border: "1px solid #ccc",
  borderRadius: 8,
  padding: "0.75rem 1rem",
} as const;
const dataStyle = {
  fontSize: "1.25rem",
  margin: "0 0 0.75rem",
  padding: "0.5rem",
  background: "#eef6ee",
  borderRadius: 4,
} as const;
const skeletonStyle = { background: "#eee", color: "#999" } as const;
const boxStyle = {
  border: "1px dashed #bbb",
  padding: "0.5rem",
  borderRadius: 4,
} as const;
const watchStyle = {
  margin: "0.25rem 0 0.75rem",
  padding: "0.5rem",
  background: "#fff8e1",
  borderRadius: 4,
} as const;
const linkStyle = { marginRight: "1rem", color: "#0066cc" } as const;
const navStyle = {
  display: "grid",
  gap: "0.25rem",
  marginBottom: "1rem",
  padding: "0.5rem 1rem",
  background: "#f6f6f6",
  borderRadius: 8,
} as const;
