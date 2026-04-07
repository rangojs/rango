"use client";

import { slowAction } from "../actions.js";

export function SlowActionTrigger() {
  return (
    <form action={slowAction}>
      <button type="submit" data-testid="slow-action-btn">
        Trigger Slow Action
      </button>
    </form>
  );
}
