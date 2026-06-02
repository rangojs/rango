"use server";

// Server actions live in their own module because React RSC requires the
// "use server" directive at the top of the file (or function). A module that
// also calls createRouter() cannot carry a top-level "use server" directive, so
// actions cannot share router.tsx. Client components import these directly and
// drive them with useActionState / useTransition.

import { redirect } from "@rangojs/router";
import { addToCartStore, bumpCount, FlashMessage } from "./shared.js";

// Fire-and-forget increment. Targeted by a revalidate() predicate on /counter
// via ctx.isAction(increment), so the CounterLoader re-runs after it completes.
export async function increment(): Promise<void> {
  bumpCount(1);
}

// useActionState-friendly variant that returns a value to render.
export async function incrementWithResult(): Promise<{ count: number }> {
  return { count: bumpCount(1) };
}

// Mutates the cart; the @cart parallel slot's loader revalidates on this action.
export async function addToCart(productId: string): Promise<{ count: number }> {
  return { count: addToCartStore(productId) };
}

// Action that redirects with typed flash location-state. Returned (not thrown).
export async function saveFlashRedirect(): Promise<void> {
  return redirect("/state", {
    state: FlashMessage({ text: "Saved via server action!" }),
  }) as unknown as void;
}
