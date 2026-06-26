# Resolved-by-default handles — design

If you're about to touch how a handle value reaches `collect` or `useHandle`, start
here. This flips one default and deletes a contract.

Today (see [handles-completion.md](./handles-completion.md) for the streaming
foundation) a handle's pushed value **may be a `Promise`** that Flight streams as a
late row, and every consumer narrows it with `isThenable` — the `DeferredHandleEntry`
contract. That puts the burden on `collect`: it's typed `(segments: TData[][]) =>
TAccumulated` (resolved `TData`), but at runtime it can receive a raw `Promise`
(`handle.ts` casts `entries as TData[]`). The default flatten-collect tolerates it
by accident; any real `collect` that reads fields gets a `Promise` and produces
garbage. That gap is what this change closes.

**The new default: a pushed promise is RESOLVED before any consumer sees it.**
`collect` always gets resolved `TData`. `useHandle` stays sync and always returns
the resolved value. `DeferredHandleEntry` is removed.

## The contract, in one line

A pushed value is awaited **iff the value itself is a thenable**. The resolve is
**shallow**:

- `set(promise)` → awaited; `collect`/`useHandle` see the resolved value.
- `set({ data: promise })` → stored verbatim; the nested promise passes straight
  through (yours to handle). `Promise.allSettled` over the entry array treats a
  non-thenable object as already-fulfilled, so this falls out for free — no deep
  traversal, no special-casing.

## Why the seam splits by render path

A single fact in the store (`handle-store.ts`) forces two halves: `settled` (which
ends the handles generator) is bumped only by `track()` — handler promises — never
by `push()`. So the generator can complete while a pushed-value promise is still
pending, and the snapshot still holds a raw `Promise`.

- **SSR / full render — resolve server-side (blocks, by design).** The full-document
  path _already_ suspends on the drained handles generator (`ssr/index.tsx`'s
  `SsrRoot`; the browser drains it before `hydrateRoot`). `useHandle` is a sync
  `'use client'` hook and can't `use()` the payload, so the payload's handle data
  must arrive pre-resolved. We extend the existing finalization to also await the
  pushed-promise _values_. This lengthens the existing document-load block by the
  pushed-promise resolve time — the deliberate "SSR resolved" cost.
- **Soft nav / action partials — resolve client-side (non-blocking).** The partial
  response keeps streaming the promise as a Flight late row (response flushes now).
  The client awaits each yield before applying it and **holds the previous value
  until it resolves** — for free, because it simply does not touch the store until
  the values resolve, so `useHandle` keeps reading (and showing) the previous data.
  This generalizes what Meta did via `resolveDeferredHandleValues` + carry-previous
  to every handle, and deletes the Meta special-casing.

## Server resolve (the riskiest seam)

At payload finalization for **full renders only**, feed the payload
`resolvedHandleStream(handleStore)` (`handles/deferred-resolution.ts`) instead of the
live `handleStore.stream()`. It **drains `stream()`** for the converged snapshot —
NOT `getData()` — then yields `resolveDeferredHandleValues(snapshot)` once. The
`stream()` drain is load-bearing: `stream()` sets the store's `completed` flag on
seal+settle and `getData()` does not, and that flag is what makes a LATE push (an
async JSX subtree that suspended and later calls `ctx.use(Handle)(...)`) throw
`LateHandlePushError` instead of silently landing. Both wait for the same `settled`
barrier, so the final snapshot is identical; we just keep the late-push guard.
`resolveDeferredHandleValues` is dependency-clean (imports only `isThenable`), so it's
reused server-side verbatim; it resolves each top-level entry and **drops rejected +
null/undefined results** (degrade, not a 500). It needs no widening of the `settled`
barrier that the cache/prerender consumers await, so those semantics are untouched.

Apply to the HTML / full-Flight payloads, leave the partials streaming:

- resolve: `rsc-rendering.ts` full-render branch, `handler.ts` 404, both
  `progressive-enhancement.ts` HTML payloads, and the prerender bake path
  (`prerender-match.ts`, three `resolveSegmentHandleValues` calls) so stored
  artifacts hold resolved values (prerender = build-time cache).
- leave streaming: `rsc-rendering.ts` partial branch, `server-action.ts` action
  error-boundary + revalidation (both `isPartial: true`) — the client
  hold-until-resolved path handles them.

Getting the HTML-vs-partial classification wrong either blocks a soft-nav response
or ships a raw `Promise` into SSR markup, so this is the part to verify hardest.

## Client hold-until-resolved

`processHandles` (`NavigationProvider.tsx`) is **await-then-apply** — the simplest
thing that works, and it needs no extra state. Per yield:

- **No deferred value** → `setHandleData(handleData)` synchronously (fast path).
- **Any deferred value** → mark the cache entry stale + handlesPending (the P1
  guard, below), `await resolveDeferredHandleValues(handleData)`, then
  `setHandleData(resolved)`.

The "hold previous" falls out for free: while the `await` is in flight we **do not
touch the store**, so `useHandle` keeps reading the previous data/segmentOrder and
shows the previous value. There is no pending set, no `useHandle` short-circuit, no
re-keying of carried entries — the store is only ever written with a fully-resolved
snapshot, so `collect` and the history cache never see a partial one.

This deliberately replaced an earlier per-handle design (a `pendingHandles` set on
the event controller + a `useHandle` short-circuit that held the previous value
while a bucket was pending). That version was correct in spirit but bug-prone — it
applied the incomplete snapshot before marking pending, did not clear pending on the
zero-yield / cached-restore paths, and could not reconstruct pending across a
popstate cache restore. Not-touching-the-store-until-resolved removes all three
failure modes by construction. The only residual: a yield mixing a deferred handle
with a sibling sync handle holds them together atomically rather than applying the
sync ones a beat earlier — which nothing needs, and which avoids a flash of
new-sync-over-old-deferred.

One field is deliberately NOT held: `routeSegmentIds`. The route HAS changed even
while the handle data is held, and `useSegments` reads `routeSegmentIds` (not the
handle buckets), so the loop calls `eventController.setRouteSegmentIds(matched)`
during the hold. That updates only `routeSegmentIds` — `data` and `segmentOrder`
(what `useHandle` collects over) stay untouched, so `useSegments` reflects the new
route while `useHandle` keeps holding its previous value.

### The P1 cache guard

A deferred value is a SERVER-side promise streamed via Flight, so a navigate-away
ABORTS the stream and the client `await` never settles. Before awaiting, mark the
entry **stale + handlesPending** (token-guarded) storing the previous (held)
snapshot: `stale` makes a popstate return revalidate; `handlesPending` makes that
revalidation a FULL re-render (no client segment IDs) so the server re-streams the
handles — a diff-only revalidation would omit the unchanged segments' handles and
the deferred value would never land. If the await DOES settle but the live page has
moved on (`!stillLive()`), we deliberately do NOT write `resolved` into the entry and
leave it stale + handlesPending. `resolved` is this yield's snapshot only (on a
partial nav, the re-resolved segments' buckets), so a correct fresh write would need
`setHandleData`'s nested per-segment merge + `matched`/`resolvedIds` cleanup —
`HandleData` is `handleName -> segmentId -> entries[]`, so a handle-name-level spread
(`{ ...prev, ...resolved }`) would drop a shared layout bucket (e.g. a `Breadcrumbs`
layout crumb under `L0` when the route pushed under `R0`) and would mark stale
previous-route buckets fresh. We can't run that merge without touching the now-
different live page, so we let the popstate return revalidate (a full re-render): the
abandoned-nav cost is one revalidation, the win is no cache corruption. A newer
same-URL nav owning the entry has already overwritten it (token guard).

## `.defer()` stays — it solves a different problem

`.defer()` lets a handler reserve a handle's slot **synchronously** and have a deep
async component / RSC subtree fill it later, without the handler holding the promise.
A plain `push` can't express that. It is, in the maintainer's words, "a promise with
an integrated timeout."

Its timeout matters **more** under this design, not less: the full render now blocks
on resolve, so a reserved-but-forgotten `.defer()` slot would hang the render —
`createDeferred`'s timeout (auto-resolve to `else`) is the safety net for exactly
that footgun. By contrast a plain `push(promise)` has **no** timeout: it represents
real work and hangs like any unresolved `await` (a loader, an async component) — and
RSC/SSR timeouts none of those, so a handle-specific timeout there would be
inconsistent.

So under resolve-by-default, `.defer()` keeps its reservation mechanism and timeout;
the only change is that the slot's promise is awaited before `collect`, so the
consumer gets the resolved value (not a `DeferredHandleEntry`).

## What's removed vs kept

- **Removed:** `DeferredHandleEntry` (consumers always get resolved values); the
  `isThenable` narrowing **inside the built-in collectors** (`collectBreadcrumbs`,
  `collectMeta`) — top-level entries are pre-resolved; `HEAD_RESOLVE_HANDLE_NAMES` +
  the `onlyHandleNames` scoping.
- **Kept:** `.defer()` / `createDeferred` / `withDefer` / `DeferOptions` / the
  timeout; `is-thenable.ts` (used solely by the resolve machinery in
  `handles/deferred-resolution.ts`); the `settled` barrier.

## Meta behavior change

With values resolved before `collectMeta` runs, a formerly-deferred (`Promise`) Meta
descriptor now participates in dedup and title-templating like any sync descriptor —
one `collectMeta` path, async == sync. This is a behavior change from today's
"append verbatim, bypass templating" for deferred descriptors, and it's intended.

## Breaking changes (pre-1.0 — remove, don't deprecate)

- `DeferredHandleEntry` removed from all entry points.
- Breadcrumbs (and any handle) delivers a resolved value (held-previous during
  resolve), never a `Promise`. A consumer that `use()`d a deferred entry deletes
  that narrowing.
- A plain `push(promise)` that hangs now hangs the full render (was: streamed a
  promise the consumer could ignore). Use `.defer()` (with its timeout) when the
  promise's settling isn't guaranteed.

## Staged plan

1. Server-side resolve at payload finalization (full-render only).
2. Generalize the client hold-until-resolved to all handles (hold collected output).
3. Remove `DeferredHandleEntry` + the in-collector `isThenable` narrowing (keep
   `defer.ts`).
4. Rewrite tests / fixtures / docs to the resolved contract — dev + production e2e
   in both the test-app and cloudflare-basic, per the repo mandate.

Any path here touches wire/barrier semantics, so the semantic matrix and dev +
production e2e are mandatory.

## Related

- [Handles completion research](./handles-completion.md) — the `settled` barrier,
  the streaming contract, and `.defer()` this builds on.
- [Rendered barrier](../internal/rendered-barrier.md) — the `ctx.rendered()` /
  `settled` contract.
- [Prerender design](../prerender-api-design.md) — the build-time handle encoding
  the server-resolve plugs into.
