"use client";

import type { ReactNode } from "react";
import { Link, useHandle, useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import { interceptHeldAction } from "./intercept-held.actions.js";
import {
  InterceptHeldCrumbs,
  InterceptHeldLoader,
  InterceptHeldPushLoader,
  InterceptPushLoader,
  InterceptRerunLoader,
} from "./intercept-held.defs.js";

export function InterceptHeldCrumbsBar() {
  const crumbs = useHandle(InterceptHeldCrumbs) ?? [];
  return (
    <ul data-testid="ih-crumbs">
      {crumbs.map((crumb, index) => (
        <li key={index} data-testid="ih-crumb">
          {crumb}
        </li>
      ))}
    </ul>
  );
}

function Dialog({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div role="dialog" data-testid={testId}>
      {children}
    </div>
  );
}

function ActionButton() {
  return (
    <button
      data-testid="ih-modal-action"
      onClick={() => void interceptHeldAction()}
    >
      Call action
    </button>
  );
}

export function InterceptHeldLoaderModal({
  id,
  renders,
  loader,
}: {
  id: string;
  renders: number;
  loader: LoaderDefinition<{ runs: number }>;
}) {
  const { data } = useLoader(loader);
  return (
    <Dialog testId="ih-modal">
      <p data-testid="ih-modal-id">{id}</p>
      <p data-testid="ih-modal-renders">{renders}</p>
      <p data-testid="ih-modal-runs">{data.runs}</p>
      <ActionButton />
    </Dialog>
  );
}

// One held loader and one following the default: the server re-runs the
// second, the browser merges it into the aggregate it holds.
export function InterceptHeldMixedModal({
  id,
  renders,
}: {
  id: string;
  renders: number;
}) {
  const held = useLoader(InterceptHeldLoader);
  const rerun = useLoader(InterceptRerunLoader);
  return (
    <Dialog testId="ih-modal">
      <p data-testid="ih-modal-id">{id}</p>
      <p data-testid="ih-modal-renders">{renders}</p>
      <p data-testid="ih-modal-runs">{held.data.runs}</p>
      <p data-testid="ih-modal-rerun-runs">{rerun.data.runs}</p>
      <ActionButton />
      {/* Another intercepted route whose modal reads the held loader. */}
      <Link
        to="/intercept-held/loader/1"
        prefetch="none"
        data-testid="ih-modal-to-loader"
      >
        Open the held-loader modal
      </Link>
    </Dialog>
  );
}

export function InterceptPushModal({ id }: { id: string }) {
  const { data } = useLoader(InterceptPushLoader);
  return (
    <Dialog testId="ih-push-modal">
      <p data-testid="ih-push-modal-id">{data.id ?? id}</p>
    </Dialog>
  );
}

export function InterceptHeldPushModal({
  id,
  renders,
}: {
  id: string;
  renders: number;
}) {
  const { data } = useLoader(InterceptHeldPushLoader);
  return (
    <Dialog testId="ih-held-push-modal">
      <p data-testid="ih-held-push-modal-id">{data.id ?? id}</p>
      <p data-testid="ih-held-push-renders">{renders}</p>
      <ActionButton />
    </Dialog>
  );
}
