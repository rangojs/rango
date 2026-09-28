// "use cache" functions written with the directive, as an app writes them.
// rangoUseCacheTransform() (vitest.rsc.config.ts) wraps each one with
// registerCachedFunction; `runs` counts body runs per function.
import type { ReactElement } from "react";
import { registerServerReference } from "@vitejs/plugin-rsc/react/rsc/server";
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
