/**
 * Filter segment IDs to only include routes and layouts.
 * Excludes parallels (contain .@) and loaders (contain D followed by digit).
 */
export function filterSegmentOrder(matched: string[]): string[] {
  return matched.filter((id) => {
    if (id.includes(".@")) return false;
    if (/D\d+\./.test(id)) return false;
    return true;
  });
}
