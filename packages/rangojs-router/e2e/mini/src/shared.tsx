// Shared, directive-free module — the boundary crossing point.
//
// This file carries NO "use client" / "use server" directive on purpose. It
// holds only what must be imported by BOTH the server and the client by
// identity, which is exactly two things:
//
//   1. Loaders the CLIENT reads via useLoader / useFetchLoader. (The server
//      also registers/runs them; the client needs the same object to subscribe
//      to its data.) A loader defined in the router file would pull the router
//      factory into the client graph; one defined in client.tsx would reach the
//      server as a $$id-only stub with no runnable fn. So they live here.
//   2. Location-state definitions read via useLocationState (client) and
//      written via redirect()/Link state (server) — same identity, both sides.
//
// Plus the in-memory stores those loaders share with the "use server" actions:
// CartLoader/CounterLoader (here) READ them and actions.tsx WRITES them, and
// neither shared.tsx nor actions.tsx may import router.tsx, so this directive-
// free module is their only common home.
//
// Everything else — route patterns, server-only loaders consumed via
// ctx.use(), context-var tokens, the product catalog — is server-only and lives
// at the top of router.tsx.

import {
  createHandle,
  createLoader,
  createLocationState,
} from "@rangojs/router";

// ---------------------------------------------------------------------------
// In-memory stores. Read by the loaders below, mutated by actions.tsx. One
// instance per server process; isolated test servers get a fresh process.
// ---------------------------------------------------------------------------

const counterStore = { value: 0 };
export function getCount(): number {
  return counterStore.value;
}
export function bumpCount(by = 1): number {
  counterStore.value += by;
  return counterStore.value;
}

const cartStore = new Map<string, number>();
export function addToCartStore(id: string): number {
  cartStore.set(id, (cartStore.get(id) ?? 0) + 1);
  return cartCount();
}
export function cartCount(): number {
  let total = 0;
  for (const qty of cartStore.values()) total += qty;
  return total;
}

// ---------------------------------------------------------------------------
// Loaders the CLIENT reads by identity (useLoader / useFetchLoader). Fresh data
// every request; the server registers/runs them, the client subscribes.
// ---------------------------------------------------------------------------

// Monotonic per-request sequence proves a loader runs fresh on every request.
// Marked fetchable (second arg `true`) so useRefreshLoaders() can re-fetch it
// through the GET loader endpoint.
let clockSeq = 0;
export const ClockLoader = createLoader(async () => {
  clockSeq += 1;
  return { seq: clockSeq, iso: new Date().toISOString() };
}, true);

export const CounterLoader = createLoader(async () => {
  return { count: getCount() };
});

export const CartLoader = createLoader(async () => {
  return { count: cartCount() };
});

// Fetchable loader — callable on demand from the client via
// useFetchLoader(EchoLoader).load(). Not registered on any route.
let echoSeq = 0;
export const EchoLoader = createLoader(async () => {
  echoSeq += 1;
  return { echo: echoSeq };
}, true);

// ---------------------------------------------------------------------------
// Shell-manifest demo (see skills/shell-manifest). The cached /manifest shell
// pushes the product ids it rendered into this handle; on a cache hit the
// handler is skipped but its pushes REPLAY, so the live loader below still
// knows exactly which prices to fetch. Handle + loader live here because the
// client reads the loader via useLoader (boundary identity).
// ---------------------------------------------------------------------------

export const RenderedProducts = createHandle<string, string[]>((segments) =>
  segments.flat(),
);

// Live price data — the dynamic holes under the frozen shell. The seq proves
// the loader runs fresh on every request while the shell stays cached.
const manifestPrices = new Map<string, number>([
  ["1", 19],
  ["2", 29],
  ["3", 39],
]);
let manifestPriceSeq = 0;
export const ManifestPricesLoader = createLoader(async (ctx) => {
  // Wait for the shell (fresh render or cache replay), then price the ids the
  // shell ACTUALLY rendered — never re-derive the list independently, or the
  // holes can desync from a stale shell.
  await ctx.rendered();
  const ids = ctx.use(RenderedProducts);
  manifestPriceSeq += 1;
  return {
    seq: manifestPriceSeq,
    prices: Object.fromEntries(
      ids.map((id) => [id, manifestPrices.get(id) ?? 0]),
    ),
  };
});

// ---------------------------------------------------------------------------
// Location-state definitions read via useLocationState (client) and written via
// redirect()/Link state (server).
// ---------------------------------------------------------------------------

export interface FlashState {
  text: string;
}
// `flash: true` auto-clears after the first paint following navigation.
export const FlashMessage = createLocationState<FlashState>({ flash: true });

export interface OriginState {
  from: string;
}
// Persistent slot — survives back/forward.
export const Origin = createLocationState<OriginState>();
