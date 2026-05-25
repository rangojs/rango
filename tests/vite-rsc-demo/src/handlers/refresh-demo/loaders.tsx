import { createLoader } from "@rangojs/router";

// Demo loaders for the client refresh-key / refresh-group showcase.
// All are fetchable so client components can refresh them via load() /
// useRefreshLoaders(). Each call returns a fresh value (and bumps a call
// counter) so a refresh is visibly different from the previous render. A small
// delay makes the in-flight / fallback states observable.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () =>
  new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const jitter = (base: number, spread: number) =>
  base + Math.floor(Math.random() * spread);

// --- Shared-key section: ONE registered loader read by two cards that share a
// key, so a refresh from one updates both. ---
let revenueCalls = 0;
export const RevenueLoader = createLoader(async () => {
  await delay(500);
  revenueCalls++;
  return {
    label: "Revenue",
    value: `$${jitter(40000, 8000).toLocaleString()}`,
    calls: revenueCalls,
    at: now(),
  };
}, true);

// --- Refresh-group section: three DIFFERENT fetchable loaders tagged into one
// group, so a single useRefreshLoaders("metrics")() refreshes all three. ---
let usersCalls = 0;
export const ActiveUsersLoader = createLoader(async () => {
  await delay(500);
  usersCalls++;
  return {
    label: "Active users",
    value: jitter(1200, 600).toLocaleString(),
    calls: usersCalls,
    at: now(),
  };
}, true);

let ordersCalls = 0;
export const OpenOrdersLoader = createLoader(async () => {
  await delay(650);
  ordersCalls++;
  return {
    label: "Open orders",
    value: jitter(80, 40).toString(),
    calls: ordersCalls,
    at: now(),
  };
}, true);

let latencyCalls = 0;
export const LatencyLoader = createLoader(async () => {
  await delay(400);
  latencyCalls++;
  return {
    label: "p95 latency",
    value: `${jitter(120, 80)} ms`,
    calls: latencyCalls,
    at: now(),
  };
}, true);

// --- Streaming section: a keyed loader whose payload arrives in two parts. The
// header (name/price) resolves with the outer object; a nested `details` promise
// is returned un-awaited, so React Flight streams it as a later chunk. The card
// reads it with use() inside a NESTED <Suspense>, so the detail row fills in a
// beat after the header. Two cards share key="product", so a load() from one is
// a single fetch whose streamed result fans out to (and re-streams) both. ---
export interface ProductData {
  name: string;
  price: string;
  calls: number;
  at: string;
  // Resolved a beat after the header; streamed as its own Flight chunk.
  details: Promise<{ rating: string; stock: string }>;
}

let productCalls = 0;
export const ProductLoader = createLoader(async (): Promise<ProductData> => {
  await delay(250);
  productCalls++;
  return {
    name: "Acme Widget",
    price: `$${jitter(100, 80)}.00`,
    calls: productCalls,
    at: now(),
    details: delay(700).then(() => ({
      rating: `${(4 + Math.random()).toFixed(1)}★`,
      stock: `${jitter(120, 240)} in stock`,
    })),
  };
}, true);
