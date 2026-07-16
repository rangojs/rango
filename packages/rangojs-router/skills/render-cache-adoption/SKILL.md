---
name: render-cache-adoption
description: Adopt Rango segment cache and PPR without freezing live request data. Use when adding cache() or ppr to a route, deciding which rendered artifact to reuse, or diagnosing a cache hit that changed loader or middleware semantics.
argument-hint: "[route]"
---

# Render Cache Adoption

Choose the reusable artifact first: `cache()` reuses non-loader Flight segments,
PPR reuses the HTML shell, and DSL loaders remain the request-visible data layer.

## Requires

Read `/rango`, `/caching`, `/ppr`, `/loader`, `/observability`, and `/testing`.
Use MCP tool schema version 3 and a browser driver.

## Preflight

Confirm compilation/discovery are current, identify the configured segment/shell
store, and record an uncached browser and `explain_render` baseline.

## Scope Selection

Select one route. Classify each read as middleware control, handler render
material, DSL-loader live data, handler-consumed baked data, or a nested promise.
State whether the desired artifact is Flight segments, an HTML shell, or both.

## Diagnostic Loop

1. Capture cold document behavior and timings.
2. Add one cache boundary or PPR declaration.
3. Move request/user data to a DSL loader; add renderable `loading()` when PPR
   must preserve a live hole.
4. Warm the route and correlate the exact request.
5. Require `explain_render` to show the intended tier hit and consumer lanes.
6. Exercise invalidation/SWR and use `explain_revalidation` for mutations.

## Edit Rules

- Never assume handler `ctx.use(loader)` is live; its rendered copy is baked.
- Do not bypass a disabled explicit cache tier by silently relying on PPR replay.
- Keep middleware serve-time and configure a shell-capable store for PPR.
- Add paired browser coverage for every consumer-visible adoption.

## Browser Verification

Verify cold and warm document loads, soft navigation, live loader content,
loading boundaries, actions, and progressive enhancement where supported.

## Dev And Production Verification

Development must show the expected cache/PPR hit and loader generations through
`explain_render`. Production must prove the same visible freshness. PPR headers
are always black-box evidence; `X-Rango-Cache` is test-only evidence and requires
`RANGO_TEST_SIGNALS=1` or `debugCacheSignal`, never a real deployment setting.
`X-Rango-Request-Id` and the MCP endpoint must remain absent.

## Bailout Conditions

Stop for request identity in shared material, missing middleware proof, no actual
hit, frozen request data, unsupported shell storage, or an unmeasured benefit.

## Teardown

Remove probe parameters and temporary timing logs. Keep the regression tests,
store configuration, and generated route files required by the adopted route.

## Reference Links

- `/caching`, `/ppr`, and `/loader` for API details.
- `/dev-loop` for request/browser correlation.
- [Fixture task](./fixtures/task.md)
