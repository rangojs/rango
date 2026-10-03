import { createHandle, createLoader } from "@rangojs/router";

// Push-ownership fixture (issues #1001, #1003), mirroring
// packages/rangojs-router/e2e/test-app/src/urls/shell-push-ownership.defs.ts:
// `ssr: false` loaders whose data and handle pushes carry the generation of
// the run that produced them. The suite bumps the generation of one ?probe=
// after the capture (/__test/ppr-push-bump), so a value from the capture
// reads @g1 and a value from a later run reads @g2. A loader's data and its
// push must agree.
const generations = new Map<string, number>();

function generationOf(probe: string): number {
  return generations.get(probe) ?? 1;
}

export function bumpPprPushGeneration(probe: string): number {
  const next = generationOf(probe) + 1;
  generations.set(probe, next);
  return next;
}

export const PprPushNotes = createHandle<string>();

export interface PprPushData {
  value: string;
}

/**
 * Returns a nested promise, so it runs on every shell HIT and on every
 * navigation that replays the shell, and pushes a settled note (#1003).
 */
export const PprPushPinnedLoader = createLoader(
  async (ctx): Promise<PprPushData & { later: Promise<string> }> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    ctx.use(PprPushNotes)(`pinned-note@g${generation}`);
    return {
      value: `pinned@g${generation}`,
      later: Promise.resolve("pinned-later"),
    };
  },
);

/**
 * Promise-free, bound with its own cache(): it pushes a settled note the
 * shell's record keeps and a deferred one it cannot (#1001).
 */
export const PprPushDeferredLoader = createLoader(
  async (ctx): Promise<PprPushData> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    ctx.use(PprPushNotes)(`settled-note@g${generation}`);
    ctx.use(PprPushNotes)(Promise.resolve(`deferred-note@g${generation}`));
    return { value: `deferred@g${generation}` };
  },
);
