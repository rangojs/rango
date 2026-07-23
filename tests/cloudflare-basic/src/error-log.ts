// Module-scoped error log for the redirect onError e2e. Lives outside
// router.tsx so urls.tsx (which router.tsx imports) can read/write it via a
// static import -- not `await import("./router.js")`. A dynamic import races
// the dev SSR module graph and occasionally returns a fresh router.js instance
// whose log array is a different reference from the one onError wrote to,
// leaving the /__test/last-error endpoint perpetually empty.
//
// Under workerd, module state lives in the isolate. As long as the worker
// reuses the isolate across requests (the default for the dev runner and the
// preview server in this fixture), a write from onError is readable by a
// follow-up /__test/last-error request. If a runtime recycled the isolate per
// request this would desync; the e2e would then read an empty log.
export interface OnErrorRecord {
  phase: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export const onErrorLog: OnErrorRecord[] = [];

export function clearOnErrorLog(): void {
  onErrorLog.length = 0;
}
