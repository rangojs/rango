import { cacheTag } from "@rangojs/router";

// "use cache" function tagged at runtime. The cached value (incl. its ts) is
// reused until one of its tags is invalidated. Shared by the /cache-tag-test
// routes and the revalidate-then-read action so both read the same entry.
export async function getTaggedItem(
  id: string,
): Promise<{ ts: number; id: string }> {
  "use cache";
  cacheTag("items", `item:${id}`);
  return { ts: Date.now(), id };
}

/** Tagged `nested-stock:<id>`; getTaggedCard reads it (#980). */
async function getTaggedStock(id: string): Promise<number> {
  "use cache";
  cacheTag(`nested-stock:${id}`);
  return Date.now();
}

/**
 * No tags of its own: its entry bakes getTaggedStock's value, so it answers
 * to the tags that call records (#980, /card/:id).
 */
export async function getTaggedCard(
  id: string,
): Promise<{ ts: number; stockTs: number }> {
  "use cache";
  return { ts: Date.now(), stockTs: await getTaggedStock(id) };
}

// /held/:id fixture (#977): the "database" getHeldItem reads, and a gate that
// holds its body after the read until the e2e releases it. Module state: one
// server process serves every request (vite dev, vite preview).
const heldSources = new Map<string, string>();
const heldRuns = new Map<string, number>();
const heldGates = new Map<
  string,
  { held: Promise<void>; release: () => void; started: boolean }
>();

/**
 * Tagged `held:<id>`: reads its source, then waits for its gate. `run`
 * counts its body runs, so an unchanged run is a HIT.
 */
export async function getHeldItem(
  id: string,
): Promise<{ value: string; run: number }> {
  "use cache";
  cacheTag(`held:${id}`);
  const run = (heldRuns.get(id) ?? 0) + 1;
  heldRuns.set(id, run);
  const value = heldSources.get(id) ?? "old";
  const gate = heldGates.get(id);
  if (gate) {
    gate.started = true;
    await gate.held;
  }
  return { value, run };
}

/** The /held/:id/:op control endpoint's operations. */
export function controlHeldItem(
  id: string,
  op: string,
): { started?: boolean } | undefined {
  switch (op) {
    case "hold": {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      heldGates.set(id, { held, release, started: false });
      return undefined;
    }
    case "started":
      return { started: heldGates.get(id)?.started === true };
    case "mutate":
      heldSources.set(id, "new");
      return undefined;
    case "release":
      heldGates.get(id)?.release();
      heldGates.delete(id);
      return undefined;
    default:
      throw new Error(`unknown op ${op}`);
  }
}
