"use client";

import { useActionState } from "react";
import { revalidateThenReadAction } from "../actions/revalidate-then-read.js";

/**
 * Form for the #973 e2e: its action calls revalidateTag(`item:<id>`) and then
 * reads that item, and this shows the ts the action read.
 */
export function RevalidateThenReadButton() {
  const [state, formAction, isPending] = useActionState(
    revalidateThenReadAction,
    null,
  );

  return (
    <form action={formAction}>
      <input name="id" data-testid="ryow-id" defaultValue="" />
      <button type="submit" disabled={isPending} data-testid="ryow-btn">
        Revalidate then read
      </button>
      {state && <span data-testid="ryow-ts">{state.ts}</span>}
    </form>
  );
}
