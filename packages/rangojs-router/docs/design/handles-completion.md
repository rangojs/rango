# Handles Completion Detection — Research & Options

If you're about to touch the handle store, the `metadata.handles` generator, or
anything that wonders "how do we know the whole RSC tree is done so we can stop
collecting handles?" — start here. This is the map of what we found when we went
looking for a better completion signal, what we proved doesn't exist (so you
don't re-derive the same dead ends), and the handful of paths that are actually
open.

The one-sentence answer up front, because it saves you a week: **there is no
in-band way to detect "the RSC tree finished rendering" with the React we ship.**
The handles generator lives inside the single Flight stream, and every signal you
might reach for to close that stream is gated by the same generator — so they all
deadlock. We verified this line-by-line in the vendored react-server-dom inside
`@vitejs/plugin-rsc`, not from blog posts. The interesting work is therefore not
"find the signal"; it's "decide whether to move handles out of the stream, and if
not, accept the contract we already have and smooth its ergonomics."

This is a research doc, not a shipped design. The git history of the handle store
itself lives in the PRs; this captures the option space as of the 2026-06 audit so
the next person starts from the conclusions, not the search.

## The problem, stated precisely

A route handler (or layout) pushes named per-segment data — breadcrumbs, meta,
whatever — into the `HandleStore` (`src/server/handle-store.ts`). The store
exposes that data to the client as an async generator embedded directly in the
payload: `metadata.handles = handleStore.stream()` (`src/rsc/rsc-rendering.ts:53`
and `:94`; `src/rsc/progressive-enhancement.ts:255` and `:363`;
`src/rsc/server-action.ts:195` and `:307`). One `renderToReadableStream` call
serializes the whole payload, so React's Flight serializer streams the generator's
yields as late rows inside the same stream the rest of the tree renders into.

Here's the bind. The only authoritative "the entire tree finished rendering"
signal is the Flight stream closing. But the handles generator is part of that
stream, so the stream cannot close until the generator completes. If you make the
generator wait for "render complete," it waits for the stream to close, which waits
for the generator — a deadlock. So today we don't use render-complete at all. The
generator completes on a different barrier: `settled`, which resolves when the
store is sealed and every _tracked handler promise_ has settled
(`handle-store.ts:163-179, 257-297`).

That barrier is narrower than "the tree is rendered." It covers handlers, because
handlers are the only segment components the router owns and invokes
(`src/router.ts:405-435` tracks them; `src/router/segment-resolution/fresh.ts:301,
547` and the revalidation equivalents are the only `track()` sites). It does **not**
cover an arbitrary async server component deeper in the user's tree that tries to
push during streaming — that push lands after `completed` has flipped and throws
`LateHandlePushError` (`handle-store.ts:232-237`). That error is the visible symptom
of the gap this research set out to close.

## What we proved does not work

Every one of these was checked against the actual vendored build the repo runs
(`@vitejs/plugin-rsc` 0.5.26, react-server-dom edge, React >= 19.2.6). Do not
re-propose them without new information from a React release that changes the
gating.

- **An in-band "all-ready-except-deferred" Flight signal.** There is no such
  thing at any layer, public or internal, on stable, canary, or experimental. The
  handles generator's stream task sits in the same `request.abortableTasks` set
  that gates stream completion, and deferred-row yields re-enter task creation, so
  "model tasks" and "deferred rows" are not disjoint classes you could wait on
  separately.
- **`cacheSignal()` (React 19.2).** Its success-path abort fires inside
  `flushCompletedChunks` only when pending work hits zero — the same gate the
  generator holds open. Circular for in-band sealing.
- **Flight `onAllReady`.** React's `RequestInstance` does carry an internal
  `onAllReady`, but the streaming `renderToReadableStream` entry hardcodes it to
  noops; only `prerender()` (the static entry) wires real callbacks. And even
  surfaced, `onAllReady` fires on `abortableTasks.size === 0`, which the generator
  keeps non-empty — so it would still wait on the very thing we want it to detect.
- **Fizz `allReady` / `onAllReady` (the SSR and progressive-enhancement paths).**
  Circular through our own `SsrRoot`, which does a root-level
  `React.use(consumeAsyncGenerator(handles))` (`src/ssr/index.tsx:266-281`). The
  HTML render suspends on the generator that `allReady` would be waiting to finish.
- **HTTP trailers.** No browser `fetch` can read response trailers (Chromium
  WontFix; never shipped elsewhere). Dead transport.
- **A second request / SSE / Durable Objects for late handle data.** Requires
  persisting per-request handle results server-side, which breaks the router's
  stateless model. On Cloudflare it would mean a Durable Object per request for
  breadcrumb-grade data — not justifiable.
- **Macrotask quiescence heuristics ("no push for N ticks").** Cloudflare
  `workerd` has no `async_hooks.createHook` (it is a silent no-op there), so there
  is no platform primitive to know all async work in a scope has drained. A timer
  heuristic is a guess, not a detector.
- **Widening the settlement barrier by tracking segment components (the "track
  more" instinct).** As literally specified this is a no-op — handlers are already
  the only router-owned components and are already tracked or awaited before seal.
  Any version that does something (walking handler-returned JSX and invoking user
  component functions outside React's render) breaks `React.cache()` /
  `cacheSignal` semantics, can't reach the nested components that actually produce
  `LateHandlePushError`, and opens a new deadlock: a tracked component that
  suspends on a loader that called `ctx.rendered()` closes a
  `settled` -> `rendered()` -> `settled` cycle the existing deadlock guard
  (`request-context.ts:826-835`) cannot see. Rejected.

The throughline: React deliberately routes "all ready" through the prerender API.
There is no streaming completion callback because the team decided streaming
shouldn't have one. Filing an upstream request was evaluated and is not a plan —
the minimal ask provably doesn't break the circularity (same `abortableTasks`
gate), and the version that would is a new, structurally awkward concept aimed at a
team pointing the other way. File the issue if you like (it costs nothing and could
refine option A's seal timing later), but do not wait on it.

## Two facts about our own code that reframe the question

Before weighing options, two things about the current implementation change what
"preserve streaming" even means.

**The full-document path already blocks on handle completion.** `SsrRoot` suspends
on the drained generator before rendering any body content
(`src/ssr/index.tsx:266-281`), and the browser drains the generator to completion
before `hydrateRoot` (`src/browser/rsc-router.tsx:196-211`). Progressive,
per-push handle updates only exist on **partial and action** navigations, where
`NavigationProvider` applies each yield as it arrives
(`src/browser/react/NavigationProvider.tsx:68`). So any option that lengthens the
generator's life makes every document load slower by exactly that amount — and any
option's "streaming TTFB preserved" claim has to be read separately for document
loads (already gated) versus partial/action (genuinely progressive). This single
fact is what disqualifies the barrier-widening family and narrows option A.

**The current contract already works, and is arguably correct.** The rule is:
_the decision to push must be synchronous (made in code that holds `ctx`), but the
pushed value may be a Promise — Flight streams it natively as a late row._ This is
documented in [`rendered-barrier.md`](../internal/rendered-barrier.md), the
push-a-promise path is real (`src/server/request-context.ts:1010-1011`), and it is
e2e-pinned (`e2e/handle-breadcrumbs.test.ts`). Read this way,
`LateHandlePushError` is not a detection failure — it is a contract-violation
signal telling a consumer they tried to _decide_ to push from a place that no
longer holds the pen. That reframing matters for picking a direction: the gap may
be ergonomics, not mechanism.

## The options that are actually open

Each was adversarially reviewed against the codebase — attacked on circularity,
mode coverage (full / partial / action / progressive-enhancement, plus the cache
layer), `workerd` compatibility, streaming regression, client/version-skew, and
abort behavior.

### A — Move handles out of the Flight stream; detect EOF

Take the handles out of the payload. Pipe the Flight stream through an identity
`TransformStream` whose `flush()` (which fires when the source closes) finalizes
the handles, then deliver the final handle data as a second, length-prefixed frame
on the _same_ response body. The client demuxes one `fetch` body into two
sub-streams: the Flight payload (decoded as today) and the trailing handles frame.

This is the only design reviewed that makes React's own renderer the quiescence
tracker, and the circularity genuinely breaks: with handles gone from the payload,
Flight EOF becomes observable, and the vendored Flight _client_ pumps the stream
eagerly (`reader.read().then(progress)` independent of consumption — confirmed in
`react-server-dom-webpack-client.edge.production.js`), so the SSR path reaches EOF
even while fizz is suspended. No deadlock.

The caveats are why it is XL, not a quick win:

- It silently degenerates to today's behavior unless you also remove the store's
  auto-seal (`handle-store.ts:259`) and make sealing pump-driven. The naive
  version re-seals at the old tracked-handlers barrier and you've changed nothing.
- As written it **destroys document and PE streaming**: blocking `SsrRoot` on an
  EOF-resolved handles promise delays the fizz shell until the entire RSC render
  finishes. The regression equals `(Flight EOF − settled)` — exactly the
  deep-async-component time. Shipping this on the document path needs a redesign
  (suspend only the handle-_consuming_ subtrees, or keep the settled barrier for
  SSR HTML and apply late pushes client-side after hydration).
- Every error/abort/cancel path must call seal, or `cacheRoute`'s `waitUntil`
  (`src/cache/cache-scope.ts:323-330`) hangs.
- Backpressure: an eager pump buffers unboundedly for slow clients; a
  backpressure-respecting pump lets a stalled client postpone seal forever. An
  abort-as-timeout failsafe is mandatory.

Where A is genuinely good is **partial and action responses**, where its streaming
story stays full (mux frames forward as produced, progressive yields preserved) and
the wire change is confined to RSC-only responses. The sensible shape is the
hybrid: A's mux for partial/action, today's settled barrier for document/PE. That
hybrid was never fully priced — it is the open design if a consumer ever
demonstrably needs autonomous deep-component pushes at runtime.

### C — Two-phase render via `prerender()`

Run a discover pass with `react-server-dom-webpack/static`'s `prerender()` (which
_does_ resolve at true quiescence — its all-ready callback fires without the
prelude being consumed, verified in the vendored build), with handles excluded from
that pass, then a streaming final pass with the now-finalized handles as plain
data.

As a **runtime** mechanism this is an opt-in escape hatch at best: the first byte
of pass two waits for full pass-one quiescence (TTFB destroyed for the route),
progressive handle updates collapse to a single final state, and React's `cache()`
is per-Flight-request so pass two runs cold — only Rango `"use cache"` content is
spared the double execution. Reserve it behind a per-route `lateHandles: true`
flag, and only if someone needs it.

The **build-time** variant, though, was floated as a cheap win: the build pipeline
already contains a full render-drain barrier (`serializeSegments` drains every
segment's Flight stream), so a seal/collect _reorder_ at
`src/router/prerender-match.ts` (~lines 275-290) and `src/rsc/rsc-rendering.ts:115-141`
looked like it would close a build-time "deep-push gap" for free.

**Correction:** that "deep-push gap" rests on the same premise disproved as bug 2
below — `serializeSegments` re-renders components but cannot push handles (no
`ctx._currentSegmentId`), so there is no missed-push gap to close, at build time or
runtime. The build path's _real_ handle defect is the same as bug 1: prerender
handle persistence `JSON.stringify`s the values, corrupting Promise/ReactNode
handles. The fix there is the Flight encoding, not a reorder — tracked as the
deferred follow-up under "Cache bugs found along the way" below.

### G — Static handle declarations

A React-Router-style declarative handle: evaluate a sync function of the match
params at segment-resolution time and push before the generator's first pull.
Zero wire change, no version skew, no platform constraints, streaming fully
preserved, every mode works through existing machinery — it was the hardest to
break. But it is sugar, not an answer: it can only express what a sync function of
params can express, which is precisely _not_ the render-computed pushes from async
subtrees that produce `LateHandlePushError`. Ship it (if usage analysis justifies
it) as a companion DX feature, as a `handle()` use-item — **not** an options field,
because `layout()` has no options bag and layouts are the primary breadcrumb
pushers. Lock its final form per the pre-release API-hygiene rule.

### The option the matrix was missing — declare-early / resolve-late

The strongest candidate for the runtime tier sits between "widen the barrier" and
"static declarations," and the original option set skipped it: a
`ctx.deferHandle(name)`-style resolver token. The handler synchronously registers
a handle slot (so `settled` and the generator complete exactly as today — no new
wait, no streaming cost), and returns a resolver that a deep async component calls
later. The _value_ rides Flight's native promise streaming as a late row. This
keeps the settled barrier as the permanent contract, preserves streaming
everywhere, and covers exactly the population G cannot express and that throws
`LateHandlePushError`. Its one limitation is the same as G's — a component cannot
push fully autonomously; it needs handler/route cooperation to register the slot —
which is the right tradeoff for the contract.

It may already work end-to-end today via push-a-promise. That is a 30-minute
fixture to confirm (see experiments below), and if it does, the practical answer to
"how do we handle deep async pushes" is a small resolver API plus docs, not a new
detection mechanism.

## Cache bugs found along the way (fixed in PR #556)

The audit surfaced two real cache defects — plus one that looked real and was
disproved on a closer read. All three were verified against the live code before
anything shipped.

1. **Promise/ReactNode handle values were silently corrupted in the Cloudflare
   cache.** `captureHandles` snapshots raw pushed values including Promises and
   React elements (`src/cache/handle-snapshot.ts`); the CF persistence sites
   `JSON.stringify` them (`cf-cache-store.ts:408, 689`), flattening a Promise to
   `{}` and dropping a `ReactNode` entirely (the Breadcrumbs `content` type). The
   in-memory store kept them by reference, so it only broke on Cloudflare —
   works-in-dev / breaks-on-CF. **Fixed** by routing the handle map through the
   same RSC-Flight codec the segments already use: `handles` is now an encoded
   string (`encodeHandles`/`decodeHandles` in `cache/handle-snapshot.ts`), with a
   bounded-timeout encode so a never-resolving handle value can't pin a background
   cache-write slot. Both stores carry the same string, so memory and CF replay
   identical decoded values.

2. **(Disproved) "Cache capture runs before the segments are drained."** The
   audit suspected `captureHandles` running before `serializeSegments`
   (`cache-scope.ts:361` then `:371`) missed deep-component pushes, and that the
   post-capture re-render could throw `LateHandlePushError`. It cannot: handles
   are pushed only via `ctx.use(Handle)`, which requires `ctx._currentSegmentId` —
   set during segment resolution, never during `serializeSegments`. Serialization
   re-renders components but has no path to `handleStore.push`, so
   capture-before-serialize cannot miss a render-time push (there are none) and
   cannot trip the late-push error. No reorder was made.

3. **A reused/dual-consumed prefetch entry dropped its handles.** A
   `DecodedPrefetch` holds a single-use `metadata.handles` generator. When a
   navigation adopts an in-flight prefetch it drains that generator, but
   `storePrefetch` — which resolves _after_ adoption — still published the same
   entry to the cache map, so a later navigation to the same URL got the exhausted
   entry and that route's breadcrumbs vanished. **Fixed** by recording adopted
   keys and skipping their publish in `storePrefetch`
   (`browser/prefetch/cache.ts`), preserving the one-time-consumption contract.
   (The tempting `cache.delete` in `consumeInflightPrefetch` is a no-op — at
   adoption time the entry is not yet cached; `storePrefetch` runs later.)

Still **deferred**: build-time prerender handle persistence
(`rsc-rendering.ts` `__prerender_collect` / `prerender-match.ts`) `JSON.stringify`s
handles the same way as bug 1 — the same corruption class on a separate
persistence layer that PR #556 did not touch. Apply the Flight encoding there too.

## Recommended sequence

1. **Run two experiments first — they decide the runtime direction.**
   - Measure `(Flight EOF − settled)` on a Suspense-heavy route (tee the RSC
     stream in `ssr-setup`, log first-fizz-flush vs Flight-EOF). That single
     number says whether option A's document-mode regression is fatal or noise.
   - Build the deferred-resolver fixture: a handler pushes a promise resolved by a
     deep async component via a shared deferred passed as a prop; assert client and
     PE output. If it works, the runtime answer is "small API + docs," which
     reorders everything below it.
2. **The direction-independent cache fixes shipped (PR #556):** the handle
   Flight-encoding (bug 1) and the prefetch adoption-suppression (bug 3). Still
   open: apply the same Flight encoding to build-time prerender handle persistence
   (the deferred follow-up above) — it `JSON.stringify`s handle values today, the
   same corruption class as bug 1.
3. **Settle the runtime tier.** Keep `settled` as the permanent contract,
   re-document `LateHandlePushError` as a contract-violation signal (not a
   window-tuning knob), and ship `deferHandle` ergonomics — plus G's static sugar
   if the usage ratio justifies it.
4. **Reserve option A** — scoped to partial/action responses only, where its
   streaming story is genuinely full — for the day a consumer demonstrably needs
   autonomous deep-component pushes. File the React `onAllReady` issue in parallel
   if you want; it only ever refines A's seal timing.

## Open questions worth answering before committing

- **How big is `(Flight EOF − settled)` on realistic routes?** Decides A's real
  TTFB cost. (Experiment 1 above.)
- **Does the deferred-resolver pattern already work end-to-end today?** Decides
  whether the runtime tier needs any mechanism at all. (Experiment 2 above.)
- **Is calling `renderToReadableStream` twice per request safe under
  `plugin-rsc` on `workerd`?** A's secondary handles stream and C's pass two both
  assume yes; believed stateless-per-call but not exercised. Test a minimal route
  decoding two streams in dev and `wrangler` production.
- **For C in dev: does a direct `vendor/static.edge` import dedupe with
  `plugin-rsc`'s `vendor/server.edge`** in the Vite optimizer, or do two Flight
  server instances race on `ReactSharedInternals`? Verify before relying on it.
- **What fraction of real handle usage is sync-match-time expressible?** Decides
  whether G earns its surface. Grep the e2e and `skills/breadcrumbs` fixtures and
  classify static-expressible vs render-computed.

Any path here touches wire format or barrier semantics, so the semantic matrix and
dev + production e2e are mandatory per the repo rules — none of the effort
estimates above trim that.

## Related

- [Rendered barrier](../internal/rendered-barrier.md) — the `ctx.rendered()` loader
  barrier and the `settled` contract this research builds on
- [Prerender design](../prerender-api-design.md) — why the build-time fix in option
  C is the natural home for handle finalization
- [Why SSR/RSC streaming uses Web Streams everywhere](../internal/why-web-streams-everywhere.md)
  — the plugin-locked-Flight constraints that bound every option here
- [SSR streaming policy](./ssr-streaming-policy.md) — stream vs all-ready mode, the
  knob that interacts with option A's document-path regression
