import { cookies } from "@rangojs/router";

// "An action makes the next navigation stale" fixture
// (e2e action-stale-navigation.test.ts). State is per test, keyed by the
// as-key cookie: the cart the action writes, and how often each layout loader
// ran on the server.
interface ActionStaleState {
  cart: number;
  cartRuns: number;
  plainRuns: number;
}

const states = new Map<string, ActionStaleState>();

export function actionStaleState(): ActionStaleState {
  const key = cookies().get("as-key")?.value ?? "";
  let state = states.get(key);
  if (!state) {
    state = { cart: 0, cartRuns: 0, plainRuns: 0 };
    states.set(key, state);
  }
  return state;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
