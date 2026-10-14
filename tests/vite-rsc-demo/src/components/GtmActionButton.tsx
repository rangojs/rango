"use client";

import { gtmPing } from "../actions/gtm.actions.js";

export function GtmActionButton() {
  return (
    <form action={gtmPing}>
      <button type="submit" data-testid="gtm-action">
        Run server action
      </button>
    </form>
  );
}
