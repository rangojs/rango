// Runtime-safe detection of a test runner (Vitest), used to decide whether a
// create*() call with no plugin-injected $$id may fall back to a synthetic id (a
// bare test) or must fail loud (dev / a real build).
//
// `process` is absent in some target runtimes (the browser, certain edge/worker
// RSC environments), so probe it through `globalThis` with optional chaining —
// NEVER a bare `process.env.VITEST`, which would ReferenceError before the
// intended error is thrown. Unlike `process.env.NODE_ENV` (folded by the app's
// build `define`), `VITEST` is not folded, so this stays a small runtime check;
// it lives only on the create*() error path (id missing), which never runs in a
// correct production build.
//
// Vitest sets `VITEST` in every test process — the node project and the
// react-server forks alike (the RSC project forces NODE_ENV=production, so NODE_ENV
// cannot distinguish it from a real build; `VITEST` can). A real build never sets it.
export function isUnderTestRunner(): boolean {
  return !!globalThis.process?.env?.VITEST;
}
