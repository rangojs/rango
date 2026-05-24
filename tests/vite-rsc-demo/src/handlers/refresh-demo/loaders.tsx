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
