"use client";

import { Link, useHandle, useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import { Modal } from "../components/Modal.js";
import {
  interceptHeldAction,
  interceptHeldRedirectAction,
} from "./intercept-held.actions.js";
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

// On the index page: an action that redirects to an intercepted route.
export function InterceptHeldRedirectButton() {
  return (
    <button
      data-testid="ih-redirect-to-intercept"
      onClick={() => void interceptHeldRedirectAction()}
    >
      Redirect to an intercepted route
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
      {/* Another intercepted route whose modal reads the held loader. */}
      <Link
        to="/intercept-held/loader/1"
        prefetch="none"
        data-testid="ih-modal-to-loader"
      >
        Open the held-loader modal
      </Link>
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

export function InterceptHeldPushModal({
  id,
  renders,
}: {
  id: string;
  renders: number;
}) {
  const { data } = useLoader(InterceptHeldPushLoader);
  return (
    <Modal testId="ih-held-push-modal">
      <p data-testid="ih-held-push-modal-id">{data.id ?? id}</p>
      <p data-testid="ih-held-push-renders">{renders}</p>
      <ActionButton />
    </Modal>
  );
}
