// SPIKE (kept server pages, part D): throwaway probe state, never merged.
// The keys of the entries a KeptOutlet holds hidden, written in its layout
// effect, and the switches the browser probe sets before the app loads
// (`window.__ksSpike`, e2e/keep-pages-frames.test.ts).

export interface KsSpike {
  /**
   * undefined: today's commit. "transition": a navigation whose route is a
   * kept entry commits in a transition (H2). "two-step": the outlet shows
   * the kept element first and the new one in a transition (H3).
   * "transition-all": every plain navigation commits in a transition (H5).
   */
  mode?: "transition" | "two-step" | "transition-all";
  log: unknown[];
}

export const SPIKE_KEPT_KEYS: Set<string> = new Set<string>();

export function ksSpike(): KsSpike | undefined {
  return (globalThis as { __ksSpike?: KsSpike }).__ksSpike;
}

/** The kept entry key whose element key names this segment id, if any. */
export function keptKeyFor(segmentId: string): string | undefined {
  for (const key of SPIKE_KEPT_KEYS) {
    const element = key.replace(/^el:(loader-boundary-)?/, "");
    if (element === segmentId || element.startsWith(`${segmentId}-`)) {
      return key;
    }
  }
  return undefined;
}
