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
