"use client";

import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { useLoader, useParams, useRouter } from "@rangojs/router/client";
import { KeepLabItemLoader, KeepLabPanelLoader } from "./keep-lab.loaders.js";
import type { KeepLabMode, KeepLabPageName } from "./keep-lab.modes.js";

// SPIKE (keep lab): what the lab's slots render. @panel is a parallel slot on
// pages A and B (page C has none); @modal is the intercept of the item route.

/** Instances mounted per key, in this document. */
const instances = new Map<string, number>();

/**
 * Numbers the component at its first commit; a show after a hide keeps the
 * number, a new instance takes the next one.
 */
function Instance({ id }: { id: string }) {
  const [instance] = useState<{ n: number }>(() => ({ n: 0 }));
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (instance.n === 0) {
      instance.n = (instances.get(id) ?? 0) + 1;
      instances.set(id, instance.n);
    }
    if (ref.current) ref.current.textContent = `#${instance.n}`;
  });
  return <span ref={ref} data-kl-slot-instance={id} />;
}

function Read({
  loader,
  label,
}: {
  loader: typeof KeepLabPanelLoader | typeof KeepLabItemLoader;
  label: string;
}) {
  const { data, isLoading } = useLoader(loader);
  return (
    <p
      data-kl-slot-data={`${label}:${data.read}`}
      data-kl-slot-loading={isLoading ? "true" : "false"}
      style={{ ...readStyle, opacity: isLoading ? 0.5 : 1 }}
    >
      {data.page}: read <strong>#{data.read}</strong> at {data.at} ·{" "}
      <code>isLoading={String(isLoading)}</code>
    </p>
  );
}

function ReadSkeleton({ label }: { label: string }) {
  return (
    <p data-kl-slot-skeleton={label} style={{ ...readStyle, ...skeleton }}>
      Loading {label}...
    </p>
  );
}

export function KeepLabPanel({
  mode,
  page,
}: {
  mode: KeepLabMode;
  page: KeepLabPageName;
}) {
  const [count, setCount] = useState(0);
  return (
    <aside data-kl-panel-slot={page} style={panelStyle}>
      <strong>@panel slot of page {page.toUpperCase()}</strong> · instance{" "}
      <Instance id={`${mode}:panel:${page}`} />
      <Suspense fallback={<ReadSkeleton label="panel" />}>
        <Read loader={KeepLabPanelLoader} label="panel" />
      </Suspense>
      <button data-kl-panel-count onClick={() => setCount((n) => n + 1)}>
        Clicked {count} times
      </button>
    </aside>
  );
}

export function KeepLabItemModal({ mode }: { mode: KeepLabMode }) {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  return (
    <div data-kl-modal={id} style={overlayStyle} onClick={() => router.back()}>
      <div style={modalStyle} onClick={(event) => event.stopPropagation()}>
        <strong>Item {id} (intercepted into @modal)</strong> · instance{" "}
        <Instance id={`${mode}:modal:${id}`} />
        <Suspense fallback={<ReadSkeleton label={`item ${id}`} />}>
          <Read loader={KeepLabItemLoader} label={`item ${id}`} />
        </Suspense>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          Note: <input data-kl-modal-input placeholder="survives a keep?" />
        </label>
        <button data-kl-modal-close onClick={() => router.back()}>
          Close (Back)
        </button>
      </div>
    </div>
  );
}

/** The intercept's loading(): the modal opens at the click with this. */
export function KeepLabModalSkeleton() {
  return (
    <div data-kl-modal-skeleton style={overlayStyle}>
      <div style={modalStyle}>
        <ReadSkeleton label="item" />
      </div>
    </div>
  );
}

export function KeepLabItemPage({ mode }: { mode: KeepLabMode }) {
  const { id } = useParams<{ id: string }>();
  return (
    <section data-kl-item-page={id} style={panelStyle}>
      <h2 style={{ margin: "0 0 0.5rem" }}>
        Item {id}, full page · instance{" "}
        <Instance id={`${mode}:item-page:${id}`} />
      </h2>
      <Suspense fallback={<ReadSkeleton label={`item ${id}`} />}>
        <Read loader={KeepLabItemLoader} label={`item ${id}`} />
      </Suspense>
    </section>
  );
}

const readStyle = {
  margin: "0.5rem 0",
  padding: "0.25rem 0.5rem",
  background: "#eef6ee",
  borderRadius: 4,
} as const;
const skeleton = { background: "#eee", color: "#999" } as const;
const panelStyle = {
  border: "1px dashed #999",
  borderRadius: 8,
  padding: "0.5rem 0.75rem",
  margin: "0.75rem 0",
} as const;
const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;
const modalStyle = {
  background: "white",
  borderRadius: 8,
  padding: "1rem 1.25rem",
  minWidth: 380,
} as const;
