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

/**
 * The hidden keys of outlets with reveal: "two-step". A slot whose kept entry
 * is here can show that entry while its loaders run, so foldInterceptLoaders
 * does not hold the commit for them (segment-system.tsx).
 */
export const SPIKE_TWO_STEP_KEPT_KEYS: Set<string> = new Set<string>();

/** A slot entry's key: its segment and its params (outlet-keep.tsx). */
export function slotEntryKey(
  segment: { id: string; params?: Record<string, string> } | null,
): string {
  if (!segment) return "slot:empty";
  const params = segment.params
    ? Object.keys(segment.params)
        .sort()
        .map((name) => `${name}=${segment.params![name]}`)
        .join("&")
    : "";
  return `slot:${segment.id}|${params}`;
}

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
