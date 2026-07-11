/**
 * Default upper bound on the capture prerender wait before forcing the abort
 * that freezes the shell — the ONLY wall-clock on the capture path, and a
 * pathological guard: it should never fire once the caller's `quiesce` is a
 * task-quantized, frozen-byte signal (the capture gate in shell-capture.ts).
 *
 * Leaf module on purpose (imports nothing): shell-capture.ts re-exports it
 * (single import site for the rsc graph — shell-build-manifest.ts sizes the
 * dev fetch envelope from that re-export) and ssr/index.tsx uses it as
 * captureShellHTML's own fallback; the ssr graph must not pull the capture
 * orchestration module for one number.
 *
 * 15s, raised from 5s: captures are background work (waitUntil), so the budget
 * costs latency-to-HIT only — never a served response — and 5s spuriously
 * refused legitimately-slow deferred shell material (a real storefront's meta
 * chains settle at ~7s). Ceiling math: workerd's waitUntil lifetime is ~30s
 * past response completion, and a guaranteed two-attempt envelope needs
 * 2x budget + the in-place retry delay + store I/O, i.e. budget <= ~14s. The
 * 15s default deliberately sits just past that: attempt 1 always gets its
 * full 15s, but when it consumed the whole budget the in-place RETRY may be
 * truncated by the platform kill on workerd — degrading to the existing
 * best-effort contract (the key stays MISS; a later request re-captures).
 * Node/dev and build-time captures have no waitUntil ceiling. The per-route
 * `ppr.captureTimeout` knob remains for tightening below the default. See
 * docs/design/ppr-shell-resume.md (Cost model).
 */
export const SHELL_CAPTURE_MAX_WAIT_MS = 15_000;
