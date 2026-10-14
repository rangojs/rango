/**
 * document.startViewTransition for a DOM test environment that has none
 * (happy-dom), run as a browser runs React's view transition: the old state
 * is captured a task later, then the update callback (React's mutation)
 * runs, then `ready` (React's spawned work) and `finished`. With it React
 * commits a transition through its view-transition path instead of its
 * fallback. `started()` counts the transitions React began, `types()` lists
 * the transition types React passed to each.
 */
export function installViewTransitionStub(): {
  started(): number;
  types(): string[][];
  uninstall(): void;
} {
  const doc = document as unknown as Record<string, unknown>;
  const types: string[][] = [];
  doc.startViewTransition = (options: {
    update: () => unknown;
    types?: Iterable<string> | null;
  }) => {
    const { update } = options;
    types.push([...(options.types ?? [])]);
    const done = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(update)
      .then(() => undefined);
    return {
      updateCallbackDone: done,
      ready: done,
      finished: done,
      skipTransition() {},
    };
  };
  if (!("fonts" in doc)) doc.fonts = { status: "loaded" };
  const root = document.documentElement as unknown as Record<string, unknown>;
  if (!("getAnimations" in root)) root.getAnimations = () => [];
  return {
    started: () => types.length,
    types: () => types,
    uninstall: () => {
      delete doc.startViewTransition;
    },
  };
}
