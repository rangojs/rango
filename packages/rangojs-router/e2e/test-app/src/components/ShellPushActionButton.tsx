"use client";

import { shellPushMetaAction } from "../urls/shell-push-ownership.actions.js";

// The push-ownership fixture's action button (#1182): the page's loaders
// re-run after the action.
export function ShellPushActionButton() {
  return (
    <form action={shellPushMetaAction}>
      <button type="submit" data-testid="push-meta-action">
        Run action
      </button>
    </form>
  );
}
