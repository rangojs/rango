"use client";

import { pprPushMetaAction } from "../actions/ppr-push-ownership.js";

// The push-ownership fixture's action button (#1182): the page's loaders
// re-run after the action.
export function PprPushActionButton() {
  return (
    <form action={pprPushMetaAction}>
      <button type="submit" data-testid="push-meta-action">
        Run action
      </button>
    </form>
  );
}
