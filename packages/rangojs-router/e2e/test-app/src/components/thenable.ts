/** Shared thenable guard for deferred-aware breadcrumb renderers. */
export function isThenable<T>(v: unknown): v is Promise<T> {
  return v != null && typeof (v as { then?: unknown }).then === "function";
}
