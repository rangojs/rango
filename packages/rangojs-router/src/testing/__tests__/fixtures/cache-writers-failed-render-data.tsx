// "use cache" functions that fail on demand, for cache-writers-failed-render.
import type { ReactElement } from "react";

export const state: { failing: boolean; runs: number } = {
  failing: true,
  runs: 0,
};

/** Throws while state.failing, as an upstream outage would. */
export async function getUpstream(): Promise<string> {
  "use cache";
  state.runs += 1;
  if (state.failing) throw new Error("upstream down");
  return "healthy-upstream";
}

async function BadChild(): Promise<ReactElement> {
  if (state.failing) throw new Error("child down");
  return <i>healthy-upstream</i>;
}

/** A cached tree whose async server component fails: a Flight error row. */
export async function getCachedTree(): Promise<ReactElement> {
  "use cache";
  state.runs += 1;
  return (
    <section>
      <BadChild />
    </section>
  );
}
