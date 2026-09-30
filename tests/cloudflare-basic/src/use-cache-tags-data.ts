import { cacheTag, getRequestContext } from "@rangojs/router";
import type { AppBindings } from "./env.js";

/** /nested-use-cache/:probe's inner tag, one per e2e probe (#980). */
export function nestedTag(probe: string): string {
  return `nested-${probe}`;
}

async function getNestedStock(probe: string): Promise<string> {
  "use cache";
  cacheTag(nestedTag(probe));
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * No tags of its own: its entry bakes getNestedStock's value, so it answers
 * to the tags that call records (#980).
 */
export async function getNestedCard(probe: string): Promise<{ stock: string }> {
  "use cache";
  return { stock: await getNestedStock(probe) };
}

// /held-use-cache/:probe (#977): the data getHeldValue reads and the hold
// flag its body waits on live in KV, so the requests that hold, change and
// release it need not share an isolate or a promise.
const HELD = "held-use-cache:";

/** /held-use-cache/:probe's tag, one per e2e probe. */
function heldTag(probe: string): string {
  return `held-${probe}`;
}

function heldKV(): KVNamespace {
  return getRequestContext<AppBindings>().env.KV;
}

/**
 * Reads its data, then waits while the probe is held. `run` is new on every
 * body run, so an unchanged one is a HIT.
 */
export async function getHeldValue(
  probe: string,
): Promise<{ value: string; run: string }> {
  "use cache";
  cacheTag(heldTag(probe));
  const kv = heldKV();
  const value = (await kv.get(`${HELD}source:${probe}`)) ?? "old";
  await kv.put(`${HELD}started:${probe}`, "1");
  while ((await kv.get(`${HELD}hold:${probe}`)) === "1") {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { value, run: crypto.randomUUID() };
}

/**
 * The /held-use-cache/:probe/:op controls: hold | started | mutate (new data,
 * then updateTag() of the probe's tag, by the caller) | release.
 */
export async function controlHeldValue(
  probe: string,
  op: string,
): Promise<{ started?: boolean; tag?: string }> {
  const kv = heldKV();
  switch (op) {
    case "hold":
      await kv.put(`${HELD}hold:${probe}`, "1");
      return {};
    case "started":
      return { started: (await kv.get(`${HELD}started:${probe}`)) === "1" };
    case "mutate":
      await kv.put(`${HELD}source:${probe}`, "new");
      return { tag: heldTag(probe) };
    case "release":
      await kv.delete(`${HELD}hold:${probe}`);
      return {};
    default:
      throw new Error(`unknown op ${op}`);
  }
}
