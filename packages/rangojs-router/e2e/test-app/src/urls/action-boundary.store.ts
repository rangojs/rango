import { cookies } from "@rangojs/router";

// The action-boundary fixture (e2e action-boundary.test.ts). The cart is per
// test, keyed by the ab-key cookie.
const carts = new Map<string, number>();

function key(): string {
  return cookies().get("ab-key")?.value ?? "";
}

export function readActionBoundaryCart(): number {
  return carts.get(key()) ?? 0;
}

export function bumpActionBoundaryCart(): number {
  const cart = readActionBoundaryCart() + 1;
  carts.set(key(), cart);
  return cart;
}

const notes = new Map<string, number>();

export function readActionBoundaryNote(): number {
  return notes.get(key()) ?? 0;
}

export function bumpActionBoundaryNote(): number {
  const note = readActionBoundaryNote() + 1;
  notes.set(key(), note);
  return note;
}
