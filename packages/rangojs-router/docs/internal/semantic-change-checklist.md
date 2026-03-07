# Semantic Change Checklist

Use this checklist for PRs that touch routing, rendering, middleware, actions,
revalidation, intercepts, prerender, or request context propagation.

## Contract

- Is the behavior consistent with [execution-model.md](./execution-model.md)?
- If not, did you explicitly update `execution-model.md`?
- Did you distinguish guarantees from non-guarantees?

## Middleware Scope

- Does this change affect global middleware scope?
- Does this change affect route middleware scope?
- Did route middleware accidentally become an action guard (or vice versa)?

## Render Path Parity

- Does JS action flow still match intended PE behavior?
- Are response headers/cookies preserved consistently across JS and PE?
- Are redirects and error paths still consistent between transport paths?

## Revalidation Semantics

- Does this change alter which segments revalidate?
- Are non-revalidated ancestors still left untouched?
- If child segments depend on outer `ctx.set()` data, is this documented/tested?
- If the producer does not revalidate, does the consumer correctly see missing/
  `undefined` data rather than retained prior-pass output?
- Are shared producer/consumer dependencies using explicit named revalidation contracts?

## Context Scope

- Does `ctx.set()` visibility remain structural (not global)?
- Are sibling boundary rules still respected?
- Are orphan/parallel scope expectations still correct?

## Intercepts

- Did intercept middleware order change?
- Are intercept and full-route paths consistent with contract?
- Are direct vs soft navigation semantics still stable?

## Prerender / Passthrough

- Does build-time prerender behavior still match documented contract?
- Does passthrough runtime behavior still obey partial revalidation rules?
- Are loader liveness/caching defaults unchanged or explicitly documented?

## Handler Loading

- Does this change affect supported handler shapes (`RouteEntry.handler`)?
- Are `manifest.ts` and `debug-manifest.ts` still enforcing the same validation?
- Is the type definition in `types/route-entry.ts` still accurate?
- Are type-level and unit-level handler contract tests updated?

## Security

- Could this change weaken action auth/authorization expectations?
- Could it introduce cookie/header leakage or redirect issues?
- Does request context remain isolated per request?

## Tests

- Did you add/update semantic e2e tests (not only unit tests)?
- Are dev and production paths both covered?
- Are JS and PE both covered when relevant?
- Are negative cases included for scope boundaries?

## Docs

- Updated relevant skill docs (`middleware`, `layout`, `parallel`, `intercept`, `prerender`, `route`)?
- Updated comments at execution choke points where behavior changed?
- Added/updated any debugging guidance if observability changed?
