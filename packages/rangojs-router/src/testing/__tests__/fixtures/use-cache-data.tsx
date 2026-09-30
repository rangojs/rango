// "use cache" functions written with the directive, as an app writes them.
// rangoUseCacheTransform() (vitest.rsc.config.ts) wraps each one with
// registerCachedFunction; `runs` counts body runs per function.
import type { ReactElement } from "react";
import { registerServerReference } from "@vitejs/plugin-rsc/react/rsc/server";
import { cacheTag } from "../../../cache/cache-tag.js";
import { Counter } from "./Counter.js";

export const runs: Record<string, number> = {};

function ran(name: string): number {
  runs[name] = (runs[name] ?? 0) + 1;
  return runs[name];
}

export async function getProduct(
  slug: string,
): Promise<{ slug: string; tags: Set<string>; updatedAt: Date }> {
  "use cache";
  ran("getProduct");
  return {
    slug,
    tags: new Set(["red", "dry"]),
    updatedAt: new Date("2026-01-02T03:04:05.000Z"),
  };
}

export async function getStock(sku: string): Promise<string> {
  "use cache";
  cacheTag("stock");
  return `${sku} #${ran("getStock")}`;
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The "database" getPrice reads; a test mutates it between requests. */
export const priceSource: { value: string } = { value: "old" };

/** Reads priceSource when it starts, then takes 30 ms to return it. */
export async function getPrice(): Promise<string> {
  "use cache";
  cacheTag("price");
  const value = priceSource.value;
  await pause(30);
  return value;
}

/** A 30 ms body tagged "stock", counting its runs. */
export async function getSlowStock(sku: string): Promise<string> {
  "use cache";
  cacheTag("stock");
  const run = ran("getSlowStock");
  await pause(30);
  return `${sku} #${run}`;
}

/** A 30 ms body tagged "unrelated", counting its runs. */
export async function getUnrelated(sku: string): Promise<string> {
  "use cache";
  cacheTag("unrelated");
  const run = ran("getUnrelated");
  await pause(30);
  return `${sku} #${run}`;
}

/** The "database" the shelf functions read; a test mutates it. */
export const shelfSource: { value: string } = { value: "old" };

/** Tagged "shelf". */
export async function getShelfStock(sku: string): Promise<string> {
  "use cache";
  cacheTag("shelf");
  ran("getShelfStock");
  return `${sku}:${shelfSource.value}`;
}

/** No tags of its own: its entry answers to what getShelfStock records. */
export async function getShelfCard(sku: string): Promise<{ stock: string }> {
  "use cache";
  ran("getShelfCard");
  return { stock: await getShelfStock(sku) };
}

/** Reads getShelfStock when it renders. */
async function ShelfStockLabel({
  sku,
}: {
  sku: string;
}): Promise<ReactElement> {
  return <span>{await getShelfStock(sku)}</span>;
}

/**
 * A "use cache" component: getShelfStock runs only when Flight encodes its
 * value, after the body returned.
 */
export async function getShelfPanel(sku: string): Promise<ReactElement> {
  "use cache";
  ran("getShelfPanel");
  return (
    <section>
      <ShelfStockLabel sku={sku} />
    </section>
  );
}

/** Tagged "zz-inner". */
export async function getLazyStock(sku: string): Promise<string> {
  "use cache";
  cacheTag("zz-inner");
  ran("getLazyStock");
  return `${sku}:${shelfSource.value}`;
}

/**
 * Returns getLazyStock's promise unawaited: it settles while the value is
 * encoded, after this call reported its tags to its caller.
 */
export async function getLazyCard(
  sku: string,
): Promise<{ stock: Promise<string> }> {
  "use cache";
  ran("getLazyCard");
  return { stock: getLazyStock(sku) };
}

/** Awaits getLazyCard; its value still holds getLazyStock's promise. */
export async function getLazyShelf(
  sku: string,
): Promise<{ card: { stock: Promise<string> } }> {
  "use cache";
  ran("getLazyShelf");
  return { card: await getLazyCard(sku) };
}

/** Holds getHeldInner's body until released. */
export const innerGate: { held: Promise<void> } = { held: Promise.resolve() };

/** Tagged "held-inner"; waits for innerGate. */
export async function getHeldInner(sku: string): Promise<string> {
  "use cache";
  cacheTag("held-inner");
  ran("getHeldInner");
  await innerGate.held;
  return `${sku}:${shelfSource.value}`;
}

/** Calls getHeldInner, which may join an execution already in flight. */
export async function getHeldOuter(sku: string): Promise<{ inner: string }> {
  "use cache";
  ran("getHeldOuter");
  return { inner: await getHeldInner(sku) };
}

/** Tagged "hot-shared": one entry per id, all under one tag. */
export async function getHotItem(id: number): Promise<string> {
  "use cache";
  cacheTag("hot-shared");
  return `hot ${id}`;
}

/** Profile "stale" (ttl 0): tagged by its run, `versioned-v<run>`. */
export async function getVersionedInner(sku: string): Promise<string> {
  "use cache: stale";
  const run = ran("getVersionedInner");
  cacheTag(`versioned-v${run}`);
  return `${sku}:v${run}`;
}

/** Reads getVersionedInner, then waits so a refresh it started can record. */
export async function getVersionedOuter(sku: string): Promise<string> {
  "use cache";
  ran("getVersionedOuter");
  const inner = await getVersionedInner(sku);
  await pause(10);
  return inner;
}

/** getStock (tagged "stock") read inside another "use cache" function. */
export async function getStockCard(sku: string): Promise<string> {
  "use cache";
  return `card(${await getStock(sku)})`;
}

/** Holds getHeldShelf's body, after it read shelfSource, until released. */
export const shelfGate: { held: Promise<void> } = { held: Promise.resolve() };

/** Tagged "held-shelf": reads shelfSource, then waits for shelfGate. */
export async function getHeldShelf(sku: string): Promise<string> {
  "use cache";
  cacheTag("held-shelf");
  ran("getHeldShelf");
  const value = shelfSource.value;
  await shelfGate.held;
  return `${sku}:${value}`;
}

export async function getDay(day: Date): Promise<string> {
  "use cache";
  ran("getDay");
  return day.toISOString().slice(0, 10);
}

export async function getGreeting(name: string): Promise<string> {
  "use cache";
  return `Hello ${name} #${ran("getGreeting")}`;
}

export async function getPanel(): Promise<ReactElement> {
  "use cache";
  return (
    <section>
      <Counter
        start={ran("getPanel")}
        when={new Date(0)}
        tags={new Map([["a", 1]])}
      />
    </section>
  );
}

type Action = () => Promise<void>;

const save: Action = registerServerReference(
  async (): Promise<void> => {},
  "src/actions.ts",
  "save",
);

export async function getForm(): Promise<{ action: Action }> {
  "use cache";
  ran("getForm");
  return { action: save };
}

export async function getReport(
  kind: "failed" | "ok",
): Promise<{ kind: string; pending?: Promise<never> }> {
  "use cache";
  ran(`getReport:${kind}`);
  if (kind === "ok") return { kind };
  const pending = Promise.reject(new Error("upstream down"));
  pending.catch(() => {});
  return { kind, pending };
}
