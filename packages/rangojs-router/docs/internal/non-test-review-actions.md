# Non-Test Review Actions (Bridge Runtime)

Status: Implemented (core findings F1-F3 addressed in navigation-bridge,
server-action-bridge, and partial-update)

Scope: non-test browser runtime files only.

Reviewed files:

- `src/browser/navigation-bridge.ts`
- `src/browser/server-action-bridge.ts`
- `src/browser/partial-update.ts`
- `src/browser/navigation-client.ts`
- `src/browser/event-controller.ts`
- `src/browser/validate-redirect-origin.ts`
- `src/browser/request-controller.ts`
- `src/browser/network-error-handler.ts`

## Findings

### F1 (Medium): Blocked redirect paths are not explicit and can fail indirectly

- `src/browser/navigation-client.ts:117-119,134-136`
- `src/browser/validate-redirect-origin.ts:8-24`

When redirect/reload headers fail origin validation, the code returns the original `Response` to Flight parsing instead of failing with an explicit redirect validation error. This can produce indirect parse/runtime failures rather than a clear reason.

### F2 (Low): `validateRedirectOrigin()` returns unnormalized input

- `src/browser/validate-redirect-origin.ts:20`

The helper validates with `new URL(...)` but returns `headerValue` rather than normalized `target.href`. Callers then operate on non-canonical values (`/x`, `//host/x`, etc.), which is inconsistent and harder to reason about.

### F3 (Low): Dead request-controller surface is still present

- `src/browser/request-controller.ts`
- `src/browser/types.ts:412-430`

`createRequestController` and `RequestController` types are not used by runtime code paths anymore (event-controller owns request/action lifecycle now). Keeping this surface increases maintenance burden and can mislead contributors.

### F4 (Low): Partial updater return contract is confusing

- `src/browser/partial-update.ts:62-84,128-142`

`PartialUpdater` is typed as returning `Promise<Promise<void>>`, while callsites treat it as ordinary `await fetchPartialUpdate(...)`. The current shape is difficult to understand and invites misuse.

### F5 (Low): Non-debug console logs still exist in hot paths

- `src/browser/server-action-bridge.ts:352`
- `src/browser/partial-update.ts:239`

A few non-error logs bypass debug gating and may produce noisy console output in production sessions.

## Proposed Commit Plan

### Commit 1: Canonical redirect validation API

Files:

- `src/browser/validate-redirect-origin.ts`
- `src/browser/navigation-client.ts`
- `src/browser/navigation-bridge.ts`
- `src/browser/partial-update.ts`
- `src/browser/server-action-bridge.ts`

Actions:

- Change validator to return canonical `target.href` on success.
- Update callsites to use the returned canonical URL value.
- Add explicit blocked-redirect handling path (clear error/report path, not parse side-effects).

Acceptance:

- Redirect/reload behavior unchanged for same-origin values.
- Blocked redirect path is explicit and deterministic.

### Commit 2: Remove or formalize dead request-controller layer

Files:

- `src/browser/request-controller.ts`
- `src/browser/types.ts`
- any exports/docs referencing request controller

Actions:

- Either remove dead API entirely, or document it as internal legacy and wire actual usage.
- If removed, delete related types and stale comments.

Acceptance:

- No runtime references remain to removed API.
- Public API surface reflects actual runtime architecture.

### Commit 3: Simplify partial updater return type

Files:

- `src/browser/partial-update.ts`
- callsites in `navigation-bridge.ts`, `server-action-bridge.ts`

Actions:

- Change `PartialUpdater` to return `Promise<void>`.
- Keep stream-completion behavior internal unless a caller explicitly needs it.
- Update naming/comments to match actual semantics.

Acceptance:

- Type signature matches runtime usage.
- No behavior change in navigation/action flows.

### Commit 4: Logging hygiene pass

Files:

- `src/browser/server-action-bridge.ts`
- `src/browser/partial-update.ts`
- (optionally) `src/browser/validate-redirect-origin.ts`

Actions:

- Route informational logs through debug gate (`debugLog`/`browserDebugLog`).
- Keep security/error logs (`console.error`, `console.warn`) explicit where needed.

Acceptance:

- Production console noise reduced.
- Diagnostic value preserved under debug mode.

### Commit 5: Abort/error consistency cleanup

Files:

- `src/browser/navigation-client.ts`
- `src/browser/server-action-bridge.ts`
- `src/browser/network-error-handler.ts`

Actions:

- Standardize abort handling semantics across bridge/client boundaries.
- Use one shared predicate for suppressible abort/background errors where practical.

Acceptance:

- Fewer edge-case differences between navigation and action pipelines.
- No regressions in silent-cancel behavior.

## Suggested Review Order

1. Commit 1 (redirect correctness and clarity)
2. Commit 2 (dead-surface cleanup)
3. Commit 3 (type/contract simplification)
4. Commit 4 (log hygiene)
5. Commit 5 (consistency pass)
