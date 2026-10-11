"use client";

import { useHandle, useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import { Modal } from "../components/Modal.js";
import { interceptHeldAction } from "./intercept-held.actions.js";
import {
  InterceptHeldCrumbs,
  InterceptHeldLoader,
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
    <Modal testId="ih-modal">
      <p data-testid="ih-modal-id">{id}</p>
      <p data-testid="ih-modal-renders">{renders}</p>
      <p data-testid="ih-modal-runs">{data.runs}</p>
      <ActionButton />
    </Modal>
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
    <Modal testId="ih-modal">
      <p data-testid="ih-modal-id">{id}</p>
      <p data-testid="ih-modal-renders">{renders}</p>
      <p data-testid="ih-modal-runs">{held.data.runs}</p>
      <p data-testid="ih-modal-rerun-runs">{rerun.data.runs}</p>
      <ActionButton />
    </Modal>
  );
}

export function InterceptPushModal({ id }: { id: string }) {
  const { data } = useLoader(InterceptPushLoader);
  return (
    <Modal testId="ih-push-modal">
      <p data-testid="ih-push-modal-id">{data.id ?? id}</p>
    </Modal>
  );
}
