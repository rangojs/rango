/**
 * `subscribe` for a useSyncExternalStore whose snapshot nothing notifies: the
 * hook is there for its server snapshot (useLocationState, useHandle), or the
 * value only changes with a render (Link's non-adaptive prefetch strategy).
 * One function, so its identity is stable across renders and hooks.
 */
export const subscribeToNothing: () => () => void = () => () => {};
