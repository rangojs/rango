import { createLoader } from "@rangojs/router";

// Fetchable counter loaders for the view-transition refresh demo. Each call
// returns a fresh value so a keyed / group refresh visibly cross-fades. A small
// delay makes the in-flight state observable.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, spread: number) =>
  base + Math.floor(Math.random() * spread);

export interface Metric {
  label: string;
  value: string;
  calls: number;
}

// Shared-key loader: two cards read it with the same key and refresh together.
let revenueCalls = 0;
export const RevenueLoader = createLoader(async () => {
  "use server";
  await delay(450);
  revenueCalls++;
  return {
    label: "Revenue",
    value: `$${jitter(40000, 8000).toLocaleString()}`,
    calls: revenueCalls,
  } satisfies Metric;
}, true);

// Group loaders: three different loaders tagged into one refreshGroup.
let usersCalls = 0;
export const ActiveUsersLoader = createLoader(async () => {
  "use server";
  await delay(450);
  usersCalls++;
  return {
    label: "Active users",
    value: jitter(1200, 600).toLocaleString(),
    calls: usersCalls,
  } satisfies Metric;
}, true);

let ordersCalls = 0;
export const OpenOrdersLoader = createLoader(async () => {
  "use server";
  await delay(600);
  ordersCalls++;
  return {
    label: "Open orders",
    value: jitter(80, 40).toString(),
    calls: ordersCalls,
  } satisfies Metric;
}, true);

let latencyCalls = 0;
export const LatencyLoader = createLoader(async () => {
  "use server";
  await delay(350);
  latencyCalls++;
  return {
    label: "p95 latency",
    value: `${jitter(120, 80)} ms`,
    calls: latencyCalls,
  } satisfies Metric;
}, true);

// Streaming loader: the header (name/price) resolves with the outer object, but
// `details` is returned un-awaited so React Flight streams it as a later chunk.
// Two cards read it with key="product"; a load() from one re-streams both.
export interface Product {
  name: string;
  price: string;
  calls: number;
  details: Promise<{ rating: string; stock: string }>;
}

let productCalls = 0;
export const ProductLoader = createLoader(async (): Promise<Product> => {
  "use server";
  await delay(250);
  productCalls++;
  return {
    name: "Acme Widget",
    price: `$${jitter(100, 80)}.00`,
    calls: productCalls,
    details: delay(700).then(() => ({
      rating: `${(4 + Math.random()).toFixed(1)}★`,
      stock: `${jitter(120, 240)} in stock`,
    })),
  };
}, true);
