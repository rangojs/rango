/**
 * document.startViewTransition for a DOM test environment that has none
 * (happy-dom), run as a browser runs React's view transition: the old state
 * is captured a task later, then the update callback (React's mutation)
 * runs, then `ready` (React's spawned work) and `finished`. With it React
 * commits a transition through its view-transition path instead of its
 * fallback. `started()` counts the transitions React began.
 */
export function installViewTransitionStub(): {
  started(): number;
  uninstall(): void;
} {
  const doc = document as unknown as Record<string, unknown>;
  let started = 0;
  doc.startViewTransition = ({ update }: { update: () => unknown }) => {
    started++;
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
    started: () => started,
    uninstall: () => {
      delete doc.startViewTransition;
    },
  };
}
