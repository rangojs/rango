---
name: dev-loop
description: Run an evidence-driven Rango development loop after an edit. Use when verifying a route, loader, action, cache, or rendering change with browser behavior and MCP request diagnostics, or when local output may be stale or ambiguous.
argument-hint: "[route-or-test]"
---

# Development Loop

Use this workflow after changing consumer-visible behavior. It joins browser
evidence to one exact development request; it does not replace tests with MCP
output or replace interactive browser checks with `curl`.

## Requires

- Read `/rango` for the execution model and `/testing` for test levels.
- A running Rango development server with the development MCP connected.
- Playwright or another browser driver for DOM, console, and network evidence.
- Tool schema version 5 with `match_route`, navigation traces,
  `explain_render`, `explain_cache_tags`, and `explain_revalidation`.

## Preflight

1. Inspect package and lockfile versions for Rango, Vite, React, and the browser
   driver. Stop if the running process uses a different install.
2. Call `get_project_metadata` and `get_discovery_status`.
3. Call `match_route` for the target URL. Use `get_routes` only when you need to
   browse or disambiguate the router; runtime-dependent declarations still need
   an observed request trace.
4. Call `get_compilation_issues` before trusting browser output. Fix current
   compilation errors first; label recent-only warnings as historical evidence.

## Scope Selection

Name one route and one interaction: document load, soft navigation, prefetch, or
action. State the browser-visible result and the server-side contract that must
remain true. Do not broaden the edit while collecting evidence.

## Diagnostic Loop

1. Perform the interaction in the browser and capture DOM, console, and network.
2. Select the exact lifecycle with `list_navigations` and
   `get_navigation_trace`. Initial documents, soft navigation, refresh,
   popstate, actions, and completed-prefetch adoption can have different request
   shapes.
3. Use `list_requests({ navigationId })` or an exact `X-Rango-Request-Id`, then
   poll `get_request_trace` and `explain_render` until their required events
   arrive. The cross-realm bridge is asynchronous; attributed loss makes the
   selected trace explicitly truncated.
4. For a mutation, call `explain_cache_tags` for invalidation activity and
   `explain_revalidation` for client-visible recomputation with the same request
   ID.
5. Cross-check framework evidence with the browser. Repeat after one focused edit.

## Edit Rules

- Fix the owning route, handler, loader, cache policy, or boundary; do not patch
  generated output.
- Keep diagnostics observational. Never add a production endpoint or serialize
  request/cached values to make a trace easier to read.
- Add userland coverage through `/testing` primitives when the public contract
  changes.

## Browser Verification

Verify the intended DOM, console, request status/headers, loading or Suspense
state, and action/navigation result. A clean trace does not prove the UI is
correct, and a correct screenshot does not prove loaders stayed live.

## Dev And Production Verification

Run the focused development e2e case and its `(production)` sibling. Development
may assert request correlation and MCP explanations. Production must assert only
black-box behavior and that the MCP endpoint/request header are absent.

## Bailout Conditions

Stop when compilation is current-broken, request selection is ambiguous, the
browser driver cannot observe the interaction, or dev and production use
different route/config sources. Report the blocker instead of guessing.

## Teardown

Close the MCP session and browser, stop only servers started for this task, and
remove temporary probes. Keep regression tests and generated route files when
routes changed.

## Reference Links

- `/observability` for production telemetry and timing.
- `/testing` for unit, integration, and paired e2e coverage.
- [Fixture task](./fixtures/task.md)
