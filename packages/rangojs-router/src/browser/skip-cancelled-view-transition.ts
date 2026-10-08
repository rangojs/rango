/**
 * #1078 candidate "d" (src/vt-experiment.ts). Not for merge.
 *
 * React starts a view transition for any eligible commit that has a
 * <ViewTransition> on its path, then cancels each group it finds unchanged
 * with a zero-duration opacity [0, 0] animation on ::view-transition-group().
 * The browser's own 250 ms animations on those groups keep running under it,
 * so the transition stays active with nothing visible and React holds the
 * next eligible commit until it finishes. This ends such a transition as soon
 * as it is ready.
 *
 * It wraps document.startViewTransition and reads React's cancel animations,
 * neither of which is a contract: a measurement of what ending the idle
 * transition is worth, not a design.
 */
interface StartedViewTransition {
  ready: Promise<unknown>;
  skipTransition(): void;
}

const GROUP_PART: RegExp =
  /^::view-transition-(group|image-pair|old|new)\((.+)\)$/;

function isReactCancel(animation: Animation, effect: KeyframeEffect): boolean {
  if ("animationName" in animation) return false;
  const keyframes = effect.getKeyframes();
  return keyframes.length > 0 && keyframes.every((k) => k.opacity === "0");
}

/**
 * React's cancel animations of this transition when they cover every group it
 * animates, else null. `stale` holds the animations that existed before the
 * transition started: a cancel animation fills forwards and outlives the
 * transition it was made for, and a later transition reuses the group names.
 */
function cancelsOfIdleTransition(stale: Set<Animation>): Animation[] | null {
  const cancels: Animation[] = [];
  const cancelled = new Set<string>();
  const running = new Set<string>();
  for (const animation of document.getAnimations()) {
    if (stale.has(animation)) continue;
    const effect = animation.effect as KeyframeEffect | null;
    const match = GROUP_PART.exec(effect?.pseudoElement ?? "");
    if (!effect || !match) continue;
    if (match[1] === "group" && isReactCancel(animation, effect)) {
      cancelled.add(match[2]);
      cancels.push(animation);
    } else {
      running.add(match[2]);
    }
  }
  if (cancelled.size === 0) return null;
  for (const name of running) {
    if (!cancelled.has(name)) return null;
  }
  return cancels;
}

let installed = false;

export function skipCancelledViewTransitions(): void {
  if (installed || typeof document === "undefined") return;
  const doc = document as unknown as {
    startViewTransition?: (arg: unknown) => StartedViewTransition;
  };
  const original = doc.startViewTransition;
  if (typeof original !== "function") return;
  installed = true;
  doc.startViewTransition = function (
    this: unknown,
    arg: unknown,
  ): StartedViewTransition {
    const stale = new Set(document.getAnimations());
    const transition = original.call(this, arg);
    transition.ready.then(
      () => {
        const cancels = cancelsOfIdleTransition(stale);
        if (!cancels) return;
        transition.skipTransition();
        for (const cancel of cancels) cancel.cancel();
      },
      () => {},
    );
    return transition;
  };
}
