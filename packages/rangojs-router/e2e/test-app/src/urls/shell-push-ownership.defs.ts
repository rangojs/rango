import { createHandle, createLoader, Meta } from "@rangojs/router";

// Push-ownership fixture (issues #1001, #1003): `ssr: false` loaders whose
// data and handle pushes carry the generation of the run that produced them.
// The suite bumps the generation of one ?probe= after the capture
// (/shell-push/__bump), so a value from the capture reads @g1 and a value
// from a later run reads @g2. A loader's data and its push must agree.
const generations = new Map<string, number>();

function generationOf(probe: string): number {
  return generations.get(probe) ?? 1;
}

export function bumpShellPushGeneration(probe: string): number {
  const next = generationOf(probe) + 1;
  generations.set(probe, next);
  return next;
}

export const ShellPushNotes = createHandle<string>();

export interface ShellPushData {
  value: string;
}

/**
 * Returns a nested promise, so it runs on every shell HIT and on every
 * navigation that replays the shell, and pushes a settled note (#1003).
 */
export const ShellPushPinnedLoader = createLoader(
  async (ctx): Promise<ShellPushData & { later: Promise<string> }> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    ctx.use(ShellPushNotes)(`pinned-note@g${generation}`);
    return {
      value: `pinned@g${generation}`,
      later: Promise.resolve("pinned-later"),
    };
  },
);

/**
 * Promise-free, bound with its own cache(): it pushes a settled note and a
 * deferred one (#1001). The shell's record keeps both, the deferred one
 * resolved (#1182).
 */
export const ShellPushDeferredLoader = createLoader(
  async (ctx): Promise<ShellPushData> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    ctx.use(ShellPushNotes)(`settled-note@g${generation}`);
    ctx.use(ShellPushNotes)(Promise.resolve(`deferred-note@g${generation}`));
    return { value: `deferred@g${generation}` };
  },
);

/**
 * Promise-free, without cache(): a shell HIT serves its pin and does not run
 * it, so its settled push reaches the page from the shell only (#1057).
 */
export const ShellPushSettledLoader = createLoader(
  async (ctx): Promise<ShellPushData> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    ctx.use(ShellPushNotes)(`settled-only@g${generation}`);
    return { value: `settled@g${generation}` };
  },
);

/**
 * A live-lane loader (no `ssr: false`), read under loading(): it pushes
 * after an await, so its push is never in the document's handle snapshot
 * and reaches the client after the root has hydrated (#1035).
 */
export const ShellPushLiveLoader = createLoader(
  async (ctx): Promise<ShellPushData> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    ctx.use(ShellPushNotes)(`live-note@g${generation}`);
    return { value: `live@g${generation}` };
  },
);

/** Longer than SHELL_PUSH_SLOW_CAPTURE_TIMEOUT_MS: the capture refuses. */
const SLOW_PUSH_DELAY_MS = 1500;
export const SHELL_PUSH_SLOW_CAPTURE_TIMEOUT_MS = 300;

/**
 * Promise-free `ssr: false` loader with a settled push and a deferred one
 * that settles after the route's ppr.captureTimeout. The capture waits for
 * the deferred push under its deadline, so it refuses, as for a handler's
 * push (#1182).
 */
export const ShellPushSlowLoader = createLoader(
  async (ctx): Promise<ShellPushData> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    ctx.use(ShellPushNotes)(`settled-note@g${generation}`);
    ctx.use(ShellPushNotes)(
      new Promise<string>((resolve) =>
        setTimeout(
          () => resolve(`deferred-note@g${generation}`),
          SLOW_PUSH_DELAY_MS,
        ),
      ),
    );
    return { value: `slow@g${generation}` };
  },
);

/**
 * #1182: an `ssr: false` loader that pushes its page title to Meta as a
 * promise. A document MISS renders the title, and the shell keeps it.
 */
export const ShellPushMetaPromiseLoader = createLoader(
  async (ctx): Promise<ShellPushData> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    ctx.use(Meta)(Promise.resolve({ title: `meta-title@g${generation}` }));
    return { value: `meta-promise@g${generation}` };
  },
);

/** The control: the same title, awaited before the push. */
export const ShellPushMetaAwaitedLoader = createLoader(
  async (ctx): Promise<ShellPushData> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    ctx.use(Meta)(
      await Promise.resolve({ title: `meta-title@g${generation}` }),
    );
    return { value: `meta-awaited@g${generation}` };
  },
);

/**
 * #1182: an `ssr: false` loader that pushes a note as a promise and is read
 * by nothing. The shell bakes the note.
 */
export const ShellPushBakedNoteLoader = createLoader(
  async (ctx): Promise<null> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    ctx.use(ShellPushNotes)(Promise.resolve(`baked-note@g${generation}`));
    return null;
  },
);

/**
 * A live-lane loader (no `ssr: false`) without pushes, read under loading():
 * the handle reader next to it hydrates inside that boundary (#1182).
 */
export const ShellPushLiveValueLoader = createLoader(
  async (ctx): Promise<ShellPushData> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { value: `live-value@g${generation}` };
  },
);
