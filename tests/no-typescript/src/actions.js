"use server";

import { getRequestContext } from "@rangojs/router";
import { ActionFlash } from "./location-states.js";
import { bumpDashboardValue } from "./store.js";

// In-memory counter mutated from the Counter page's client component.
let counter = 0;

export async function getCounter() {
  return counter;
}

export async function incrementCounter() {
  counter += 1;
  return counter;
}

export async function decrementCounter() {
  counter -= 1;
  return counter;
}

// Mutates the shared dashboard value. The /dashboard route's revalidate()
// predicate matches any action, so DashboardLoader re-runs and useLoader
// reflects the new value without a navigation.
export async function bumpDashboard() {
  return bumpDashboardValue();
}

// Writes location state from a server action (non-redirect flow). The state
// reaches the client through the action response and is read by
// useLocationState(ActionFlash).
export async function setFlash() {
  const ctx = getRequestContext();
  ctx.setLocationState([ActionFlash({ message: "saved-from-action" })]);
  return "ok";
}
