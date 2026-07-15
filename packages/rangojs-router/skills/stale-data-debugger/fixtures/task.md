# Stale Data Debugger Fixture

## Broken State

A server action succeeds, but the route's `revalidate()` predicate returns false.
The child segment is skipped, so its action-result cookie remains unset even
though the action request completed successfully.

Apply `setup.patch` from the repository root before starting. Run `verify.mjs`
before and after the repair; it must fail red, then pass Node and Cloudflare in
both development and production.

## Expected Diagnosis

Correlate the action with `explain_revalidation` and identify the child segment's
`finalShouldRevalidate: false` decision. Distinguish segment selection from cache
freshness or browser reuse.

## Required Edit

Restore the child route's true revalidation predicate. Do not compensate with
cache TTL, client-cache, or forced-refresh changes.

## Dev Verification

Assert the action selects the intended segment and the browser shows the action
cookie set by the rerun handler.

## Production Verification

Run the paired production action and assert the cookie is set without MCP or
diagnostic headers. The shared verifier also checks Cloudflare action-trace
availability in development and production diagnostic isolation.
