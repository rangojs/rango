/** Notify every active listener and surface every callback failure. */
export function notifyListeners<T>(
  entries: Iterable<T>,
  notify: (entry: T) => void,
  isActive?: (entry: T) => boolean,
  shouldContinue?: () => boolean,
): void {
  const errors: unknown[] = [];
  for (const entry of entries) {
    if (shouldContinue && !shouldContinue()) break;
    if (isActive && !isActive(entry)) continue;
    try {
      notify(entry);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple listener callbacks failed");
  }
}
