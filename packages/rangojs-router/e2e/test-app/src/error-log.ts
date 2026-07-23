// Module-scoped error log for the e2e onError tests. Lives outside
// router.tsx so urls.tsx (which router.tsx imports) can read/write it
// via a static import — not `await import("./router.js")`. The dynamic
// import races the dev SSR module graph and occasionally returns a
// fresh router.js instance whose `onErrorLog` array is a different
// reference from the one the action handler wrote to, leaving the
// /__test/last-error endpoint perpetually empty.
export interface OnErrorRecord {
  phase: string;
  message: string;
  actionId?: string;
  metadata?: Record<string, unknown>;
}

export const onErrorLog: OnErrorRecord[] = [];

export function clearOnErrorLog(): void {
  onErrorLog.length = 0;
}
