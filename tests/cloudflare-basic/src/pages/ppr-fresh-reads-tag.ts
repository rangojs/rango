/** The /ppr-fresh-reads shell tag for an e2e probe (colon-free, per run). */
export function freshReadsTag(probe: string): string {
  return `ppr-fresh-reads-${probe}`;
}
