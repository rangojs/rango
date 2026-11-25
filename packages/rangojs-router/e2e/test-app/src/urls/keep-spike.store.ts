// SPIKE (kept pages, part C): actions per variant (keep-spike.actions.ts),
// read by the pages' loaders (keep-spike.loaders.ts).
const acts = new Map<string, number>();

export function getKeepSpikeActs(variant: string): number {
  return acts.get(variant) ?? 0;
}

export function bumpKeepSpikeActs(variant: string): number {
  const next = getKeepSpikeActs(variant) + 1;
  acts.set(variant, next);
  return next;
}
