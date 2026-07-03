# Serving PPR shells via Vercel's CDN-stitched chain

If you're picking up the Vercel side of PPR shell caching — the "serve the shell
from the PoP cache, POST-resume to the function" mode that Next PPR uses on
Vercel — start here. This is the adapter specification. It records the protocol
as it is actually implemented in Vercel's and Next's source (there is no public
spec for it — the builder source _is_ the spec), what part of it is safe to
build on, and the exact shape the Rango vercel preset would have to grow to
participate.

Read [`ppr-shell-resume.md`](./ppr-shell-resume.md) first. This doc is the
Vercel-transport continuation of the axis-2 design described there. That doc
deliberately scoped the chain mechanism **out** of v1 ("The Build Output API
`chain` mechanism ... exists but is undocumented and Next-only in practice —
deliberately out of scope; revisit with Vercel directly"). This is that revisit,
on paper, before any code.

One framing you need up front: the in-function resume path that ships today (the
shell-cache middleware + `VercelCacheStore`'s `getShell`/`putShell` family) is
the **universal** Vercel story and it is already source-complete. The chain path
in this doc is a TTFB optimization layered on top of it for a subset of routes —
not a replacement, and not a prerequisite for shipping PPR on Vercel. Keep that
proportion in mind while reading; most of the risk lives in the chain path, and
the fallback to in-function resume is what makes that risk survivable.

## Verification status

Everything in the "Protocol as implemented" section below is **source-derived,
not empirically reproduced**. It is read out of `vercel/vercel@main` and
`vercel/next.js` (canary), cross-checked against the public Next.js adapter and
PPR-platform docs. I did not scaffold a Next 16 `cacheComponents` app and diff a
real `.vercel/output` for a PPR route — the source citations are specific enough
to design against, and the one thing an empirical run would add (confirming the
PoP honours a _non-Next_ builder's `chain`) is precisely the thing that requires
a Vercel conversation, not a local build, to settle. When we get a green light to
implement, a throwaway deploy against a hand-authored `.prerender-config.json`
(see "Open questions", Q1/Q2) is the right first spike.

## The protocol as implemented (from source)

### The two representations of the same pair

A PPR route reduces to one pair of artifacts: a **static HTML shell** (React's
`prerender` prelude — the layouts plus Suspense fallbacks) and a **postponed
state** blob (the serialized resume token from the same `prerender` abort). Every
layer below transports that same pair; only the encoding changes.

Vercel exposes the pair in two encodings, and it matters which one you are
looking at:

1. **The Next adapter API** (public, `nextjs.org/docs/app/api-reference/adapters/*`,
   Next 16) presents the pair as a _structured_ object — the shell file and the
   postponed state are separate fields. This is what a third party building a
   _Next.js_ platform adapter consumes.
2. **The Vercel Build Output API on disk** (what actually lands in
   `.vercel/output`, produced by the `@vercel/next` builder) presents the pair as
   a _concatenated_ file plus a content-type that tells the CDN where to cut it.
   This is what Rango would have to emit, because Rango is not a Next adapter — it
   writes Build Output directly (see `src/vite/plugins/vercel-output.ts`).

Get these two confused and the spec falls apart, so both are laid out below.

### Representation 1 — the Next adapter output shape (public)

From `nextjs.org/docs/app/api-reference/adapters/output-types`, a PPR route
appears in `outputs.prerenders[]` as:

```ts
{
  type: 'PRERENDER'
  pathname: string
  parentOutputId: string
  groupId: number                       // routes sharing a groupId revalidate together
  pprChain?: {
    headers: Record<string, string>     // e.g. { 'next-resume': '1' }
  }
  fallback?: {
    filePath: string | undefined        // the generated shell file (HTML)
    postponedState: string | undefined  // serialized PPR resume state
    initialStatus?: number
    initialHeaders?: Record<string, string | string[]>
    initialRevalidate?: number | false
    initialExpiration?: number
  }
  config: {
    renderingMode?: 'STATIC' | 'PARTIALLY_STATIC'   // PARTIALLY_STATIC = PPR
    partialFallback?: boolean
    bypassToken?: string
    allowQuery?: string[]
    allowHeader?: string[]
    bypassFor?: RouteHas[]
  }
}
```

The two load-bearing fields: `config.renderingMode === 'PARTIALLY_STATIC'` marks
the route as PPR, and `fallback.postponedState` is the opaque resume blob. The
Next docs are explicit that `postponedState` must be treated as opaque — passed
through byte-for-byte, never parsed or mutated, or "incorrect dynamic rendering
output" results.

### Representation 2 — the Build Output on disk (`@vercel/next` builder)

This is the encoding Rango would produce. From `vercel/vercel`
`packages/build-utils/src/prerender.ts`, the `Prerender` output object carries
these chain-relevant fields (constructor arguments, verbatim field names):

```
fallback: File | null
group?: number
initialHeaders?: Record<string, string>
initialStatus?: number
sourcePath?: string
allowQuery?: string[]
allowHeader?: string[]
experimentalStreamingLambdaPath?: string
chain?: Chain
partialFallback?: boolean
hasPostponed?: boolean
```

`Chain` itself (`packages/build-utils/src/types.ts`) is tiny:

```ts
export interface Chain {
  /** The build output that references the lambda used to append to the response. */
  outputPath: string;
  /** The headers to send when making the request to append to the response. */
  headers: Record<string, string>;
}
```

`packages/build-utils/src/collect-build-result/get-prerender-chain.ts` normalizes
the two spellings a builder can use:

- if `prerender.chain` is set, use its `{ outputPath, headers }` directly;
- else if `prerender.experimentalStreamingLambdaPath` is set, synthesize
  `{ outputPath: <that path>, headers: { 'x-matched-path': <that path> } }`;
- else no chain (an ordinary prerender, not PPR).

So `chain` is the explicit form and `experimentalStreamingLambdaPath` is the
legacy/experimental shorthand for the same thing, differing only in that the
shorthand hard-codes a single `x-matched-path` header.

On disk, `packages/cli/src/util/build/write-build-result.ts` writes the Prerender
as two files next to the function:

```
<path>.prerender-config.json     // JSON.stringify({ ...output, lambda: undefined, fallback })
<path>.prerender-fallback<ext>   // the static shell file (ext from the fallback File)
```

The config JSON is a straight spread of the Prerender object, so whatever fields
the builder set — `chain`, `experimentalStreamingLambdaPath`, `group`,
`initialHeaders`, `initialStatus`, `sourcePath`, `allowQuery`, `bypassToken` —
all land in `<path>.prerender-config.json` verbatim. There is no `renderingMode`
field at this layer; `PARTIALLY_STATIC` is a Next-adapter-level concept that the
builder has already translated into "there is a `chain`" by the time it reaches
Build Output.

### Where the postponed blob lives, and how it reaches the POST body

This is the crux of the whole protocol and the part with no public
documentation. From the `@vercel/next` builder (`vercel/vercel`
`packages/next/src/utils.ts`, in the prerender-route handling), when a route
postpones, the fallback file is **not** just HTML — it is the postponed state
_prepended_ to the HTML, and the content-type encodes the split point:

```
initialHeaders['content-type'] =
  `application/x-nextjs-pre-render; state-length=${postponedState.length}; origin="text/html; charset=utf-8"`;
postponedPrerender = postponedState + html;      // concatenated, in that order
// ... written into a FileBlob as the fallback file
```

So `<path>.prerender-fallback` on disk is the byte sequence
`[postponedState][html shell]`, and the `content-type` header tells the CDN:

- `state-length=N` — the first `N` bytes are the postponed state;
- `origin="text/html; charset=utf-8"` — the _rest_ is HTML, and this is the
  content-type to hand the client for it.

The PoP behaviour that this content-type drives (inferred from the encoding — it
is the only reading that makes the pieces fit, and it matches the platform
guide's description of the flow):

1. The PoP serves the shell from cache. It reads `state-length`, slices off the
   first `N` bytes as the postponed state, and streams the remaining HTML bytes to
   the client immediately under the `origin` content-type.
2. In parallel, it issues the **chained** request to `chain.outputPath` (the
   streaming/resume lambda), carrying `chain.headers` and the sliced-off postponed
   bytes as the request body.
3. The resume lambda renders only the deferred holes and streams them back; the
   PoP concatenates that stream after the shell HTML into one response.

The chain headers combine what the two source layers set: the builder's
`x-matched-path` (routing the chained request back to the right function) plus
the PPR resume marker `next-resume: 1` (the platform guide states `pprChain.headers`
contains `{ 'next-resume': '1' }`).

### The resume request contract

From `nextjs.org/docs/app/guides/ppr-platform-guide` (the "Resume Protocol"
section), the CDN-to-origin handshake is:

| Field    | Value                                                 |
| -------- | ----------------------------------------------------- |
| method   | `POST`                                                |
| header   | `next-resume: 1`                                      |
| body     | the `postponedState` blob (opaque, byte-for-byte)     |
| response | a stream of **only** the deferred Suspense boundaries |

Two refinements from the same source:

- When a Server Action and a resume ride in the same request, the body is
  `postponedState` followed by the action body, and `x-next-resume-state-length`
  carries the byte length of the postponed prefix so the handler can split them.
  For a pure PPR resume — the only case Rango would ever emit, since Rango actions
  are axis-1 — the whole body is the postponed state and that header is absent.
- The adapter form skips HTTP entirely: `handler(req, res, { requestMeta: { postponed } })`.
  Not relevant to the Vercel-CDN path (which is HTTP), but it confirms the
  postponed blob is transport-agnostic input to the renderer — which is exactly
  the shape Rango's `resumeShellHTML` already has (see below).

### The revalidation update path

From `implementing-ppr-in-an-adapter` and the platform guide: the shell and the
postponed state are a **coupled pair** and must be stored and updated
**atomically**. Serving a new shell with an old postponed blob (or vice versa)
produces incorrect dynamic output — this is the same version-coupling invariant
Rango's `ShellCacheEntry` already enforces by carrying `prelude` and `postponed`
in one entry (`src/cache/types.ts`).

On revalidation (time-based ISR via `group`/`initialRevalidate`, or on-demand via
tags), Next regenerates both together. Adapters observe the new pair through
`requestMeta.onCacheEntryV2(cacheEntry, meta)`: when `cacheEntry.value.kind === 'APP_PAGE'`
they read `cacheEntry.value.html` (via `toUnchunkedString()`),
`cacheEntry.value.postponed`, `.headers`, `.status`, and `cacheEntry.cacheControl`,
then persist the pair to the platform cache. That callback is a _Next-runtime_
hook, so it is not directly available to a non-Next builder — for Rango the
equivalent is "recapture writes a new shell+postponed pair" (the SWR recapture
the shell-cache middleware already schedules), plus re-publishing the fallback
file, which on the chain path means a redeploy or an ISR-style write into PoP
storage (see Open questions Q5).

## What's public, what's undocumented, what's Next-only

| Layer                                                                                                                                    | Status                                          | Notes                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderingMode: 'PARTIALLY_STATIC'`, `fallback.postponedState`, `pprChain.headers`, the `next-resume: 1` POST protocol, `onCacheEntryV2` | **Public**, documented in the Next adapter docs | But this is the contract for building a **Next.js** platform adapter, not a Build Output contract. It describes consuming Next's output, not emitting your own. |
| `Prerender.chain` / `Chain` type                                                                                                         | **Semi-public**                                 | Exists in the published `@vercel/build-utils` types. No public Build Output API doc describes `chain` or its CDN semantics.                                     |
| `Prerender.experimentalStreamingLambdaPath`                                                                                              | **Explicitly unstable**                         | The `experimental` prefix is the stability signal: Vercel can change or remove it with no semver guarantee.                                                     |
| The `application/x-nextjs-pre-render; state-length=N; origin=...` content-type and the PoP slice/stitch behaviour                        | **Undocumented, Vercel-internal**               | The single most load-bearing piece of the protocol, and the one with zero public specification. Reverse-read from the `@vercel/next` builder source.            |
| The end-to-end chain emission                                                                                                            | **Next-only in practice**                       | No framework other than Next emits `chain`/`experimentalStreamingLambdaPath` today. Vercel's PoP is only tested against Next's output.                          |

### Risk statement

Building Rango's Vercel PPR fast-path on `chain` means depending on three things
that can move without warning:

1. an `experimental`-prefixed field (or an undocumented `chain` field) that
   carries no semver commitment;
2. an **undocumented CDN stitching protocol** — the `x-nextjs-pre-render`
   content-type split — that only Next's builder exercises and that Vercel only
   regression-tests against Next's output;
3. **no contract** that the PoP will honour a _non-Next_ builder's `chain`. It
   may be gated to `@vercel/next` output; we cannot tell from source.

A Vercel platform change to any of these would break Rango's shells silently — no
compile error, no type break, just a route that stops stitching (or worse,
stitches wrong). That is why the chain path is worth pursuing **only** behind a
direct Vercel conversation and **only** with the in-function fallback as the
always-available floor. The downside of being wrong about an undocumented
protocol is a production correctness bug, not a slow page.

## The Rango adapter spec

### Prerequisites

**#1 — Build-time shell capture (currently deferred v1 work).** The chain path
needs the shell prelude + postponed pair to exist _at build time_, written into
`.vercel/output` before deploy, because the PoP serves the fallback file from
storage — there is no runtime capture in the picture. Rango v1 captures at
runtime, via a background re-render after the first MISS
(`src/cache/shell-capture.ts`, `scheduleShellCapture`). That model cannot feed
the chain: the PoP needs bytes on disk at deploy time. So the first prerequisite
is the **build-time capture pipeline** — the B-segment / prerender path described
in `../prerender-api-design.md` and listed as out-of-scope in
`ppr-shell-resume.md` — producing `{ prelude, postponed }` per shell-cached route
during `vite build`. This is genuine net-new work; `vercel-output.ts` today emits
a single catch-all function and no prerender artifacts at all.

**#2 — Deterministic capture.** React's `resume` requires the tree above the
holes to match the tree that was prerendered (the "correctness property we get
for free" in `ppr-shell-resume.md`). With runtime capture, the same closure-scoped
`SsrRoot` renders both passes over the same replayed segments, so identity holds
by construction. With _build-time_ capture and a _separate_ resume invocation at
request time, that guarantee has to be re-established deliberately: the build-time
shell must render over the same replayed/deterministic segments the resume pass
will see. The existing consistency mechanism carries over — `cache()` the route so
the same segments feed both passes, and the capture-time guards that already make
non-deterministic shells PPR-ineligible (`cookies()`/`headers()` throw inside a
capture render via `assertNotInsideShellCapture`, `cookie-store.ts`) keep
per-request content out of the shell. Build-time capture must run under the same
masking/guard regime as runtime capture, not a looser one.

### What the vercel preset must emit per shell-cached route

Extending `src/vite/plugins/vercel-output.ts` (`assemble()`), for each route that
opts into build-time shell caching:

1. **The fallback file** `.vercel/output/functions/<route>.prerender-fallback.html`,
   laid out the way the PoP expects — the postponed state prepended to the prelude
   bytes: `[postponed][prelude]`, with the emitted `initialHeaders` carrying
   `content-type: application/x-nextjs-pre-render; state-length=${postponed.length}; origin="text/html; charset=utf-8"`.
   (Whether the PoP accepts this content-type from a non-Next builder is Open
   question Q2 — this is the single riskiest emitted byte.)
2. **The prerender config** `.vercel/output/functions/<route>.prerender-config.json`,
   a Build Output `Prerender` with:
   - `fallback` pointing at the file above;
   - `chain: { outputPath: <resume-function-path>, headers: { 'next-resume': '1', 'x-matched-path': '/<route>' } }`
     (or the `experimentalStreamingLambdaPath` shorthand — Q3);
   - `group` / `initialRevalidate` for the TTL, mirroring the shell entry's TTL/SWR;
   - `initialStatus`, `allowQuery` as needed.
3. **A resume function output** at `chain.outputPath` — see below. It can be a
   second `.func` (e.g. `<name>-resume.func`) or a distinct route on the existing
   function; the chain's `outputPath` and `x-matched-path` just have to resolve to
   it.
4. **A `config.json` route** so a request for the route hits the prerender (served
   from PoP cache) rather than falling straight through to the catch-all function.
   Today `buildVercelOutputConfig` routes everything to `/<functionName>` after the
   filesystem handler; the PPR routes have to be registered ahead of that so the
   PoP shell cache is consulted first.

### The resume endpoint

This is a thin adapter over the SSR resume handler Rango already has.
`resumeShellHTML` (returned by `createShellResumeHandler`, `src/ssr/index.tsx`)
takes exactly `{ postponed: string | null; nonce?: string }` plus the fresh Flight
stream — it is already transport-agnostic about where `postponed` came from. On
the in-function path it comes from the store; on the chain path it comes from the
request body. Same function, different feed.

**Route shape.** A dedicated function output the chain targets. It receives:

- method `POST`, header `next-resume: 1`;
- body = the postponed state (whole body — pure resume, no action framing; honour
  `x-next-resume-state-length` defensively but Rango never emits the combined
  form).

**What it does.** Recover the postponed state from the body, run the _full fresh
Flight render_ for the route (the same `router.match()` -> `buildFullPayload`
(`src/rsc/full-payload.ts`) -> Flight render path the foreground uses, minus the
SSR shell pass), then call `resumeShellHTML(freshFlight, { postponed, nonce })`
and stream the result. The PoP appends it to the shell it already sent.

**The reactVersion gate has to move.** Today the gate lives in the store read
path: `shell-cache.ts` compares `entry.reactVersion === React.version` and treats
a mismatch as a MISS, and `VercelCacheStore.getShell` returns the stored
`reactVersion` for exactly that check. On the chain path the store is **not
consulted at resume** — the postponed blob arrives in the request body from a
PoP-cached file, so nothing checks its version. The gate must move into the
transport. Two options:

- (a) **Embed it in the blob.** Wrap the stored postponed state in a small
  envelope carrying `reactVersion` (and the route key — see security below), and
  verify it at resume. This travels with the bytes, so it survives the PoP round
  trip.
- (b) **Carry it in a chain header.** Set `x-rango-react-version` in `chain.headers`
  at build and compare at resume. Simpler, but headers are more likely to be
  dropped/rewritten by an intermediary than the body is.

Prefer (a): the version is part of the signed envelope anyway (below), so it costs
nothing extra and cannot be stripped independently of the blob. On mismatch the
resume function **falls back to a full render** — it has the whole request, so it
can render axis-1 and stream a complete document — rather than resuming a
stale-versioned blob.

**Security — the resume endpoint accepts attacker-controlled bytes.** This is a
real requirement, not a hardening nicety. The resume function is an HTTP endpoint.
The CDN is trusted, but the endpoint is reachable directly from the internet, and
a direct `POST /<resume-path>` with `next-resume: 1` and a crafted body lands that
body in `resume()`. This is exactly the class Next has already been bitten by,
twice:

- **CVE-2025-59472** — `base-server.ts` buffered the resume POST body with an
  unbounded `Buffer.concat`, and the resume-data-cache decompressed it with
  `inflateSync()` with no output cap (a small compressed payload expands to
  gigabytes). Unauthenticated POST with `Next-Resume: 1` + a crafted body.
  Patched by adding buffering checks and a `maxOutputLength` on the inflate.
- **CVE-2026-27979** (GHSA-h27x-g6w4-24gq) — the same unbounded buffering survived
  in non-minimal deployments. Next's own advisory states it plainly: the
  `next-resume` header **"is never valid to be sent from an untrusted client."**

Rango's resume endpoint has the identical exposure. The mitigation, in priority
order:

1. **Sign the blob at build; verify at resume. This is the primary control.** At
   build/capture time, HMAC the postponed envelope with a per-deploy secret
   (derive from `VERCEL_DEPLOYMENT_ID` or a build-injected secret that the
   function also reads at runtime), and store the tag inside the envelope. At
   resume, recompute the HMAC over the received bytes and reject on mismatch. Only
   the build pipeline knows the secret, so a crafted internet body cannot forge a
   valid tag — `resume()` runs **only** on bytes Rango itself produced. This
   converts "feed arbitrary attacker bytes into React `resume()`" into "feed only
   build-signed bytes," which is the whole ballgame.
2. **Bind the signature to the route and the React version.** HMAC over
   `pathname || reactVersion || postponed`, not `postponed` alone. A valid blob for
   route A then cannot be replayed against route B's resume (which would render B's
   fresh Flight against A's postponed tree — garbage or a hydration mismatch).
   React's tree-shape check already catches most of this, but the binding fails
   fast and cheaply, and folds the version gate (above) into the same check.
3. **Hard size cap before parsing.** Cap the buffered body and error past it —
   never an unbounded `Buffer.concat`. This is the direct Next CVE fix; reuse a
   dedicated cap (the shell prelude already respects `VERCEL_MAX_ITEM_BYTES` on the
   store side, `vercel-cache-store.ts`).
4. **Do not decompress.** Rango's postponed state is stored and transported as
   uncompressed base64/JSON — keep it that way. Adding an inflate step would
   reintroduce the second CVE leg; if a future version must compress, cap the
   inflate output length.
5. **Method/rate-gate as belt-and-suspenders.** Reject non-POST, reject a missing
   resume header, rate-limit — but treat all of this as secondary. The HMAC is what
   actually makes the endpoint safe; without it, none of the rest matters.

If Open question Q6 comes back with "the PoP signs chained requests," that
supplements the HMAC but does not replace it — the endpoint is still directly
reachable, so the blob-signature must stand on its own.

### Fallback when chain is absent

The current **in-function** resume path stays the universal, supported floor on
every platform. On Vercel that is the shell-cache middleware
(`createShellCacheMiddleware`, `@rangojs/router/cache`) plus `VercelCacheStore`'s
`getShell`/`putShell` family running on Fluid Compute — the function reads the
shell entry, resumes, and composes the response itself, with no Build Output
chain, no build-time capture, and no undocumented protocol. When chain emission is
absent or disabled (the default, and the only mode until the Vercel conversation
lands), every shell-cached route serves via in-function resume exactly as it does
today. The chain path is strictly additive: a per-route opt-in that, when the
platform honours it, moves the shell's TTFB down to edge latency, and when it
doesn't, is simply not emitted and nothing changes.

## Open questions for Vercel

1. **Will the PoP honour `chain` / `experimentalStreamingLambdaPath` on a
   `.prerender-config.json` emitted by a non-Next builder,** or is the chain path
   gated to `@vercel/next` output? No public Build Output doc covers `chain`, so we
   cannot answer this from source.
2. **Is `application/x-nextjs-pre-render; state-length=N; origin=...` the actual
   CDN slice/stitch contract,** and is it stable and usable by third parties, or
   strictly Next-internal? This is the byte that carries the whole mechanism.
3. **`chain` vs `experimentalStreamingLambdaPath`** — which is the recommended
   seam, and what is the stability commitment on the `experimental` prefix?
4. **Does the PoP send the postponed prefix as the resume POST body automatically**
   (derived from the `state-length` split), or must the builder arrange the body
   some other way?
5. **Revalidation for a non-Next builder** — how does a shell+postponed pair get
   updated in PoP storage without the Next runtime's `onCacheEntryV2`? Is it purely
   `group` / `initialRevalidate` + a redeploy, or is there a write path (an ISR-style
   PoP write) a third-party builder can use?
6. **Does the PoP add any trust marker to chained requests** so the origin can
   distinguish a genuine PoP resume from a direct internet POST? (Even if yes, we
   still sign the blob — the endpoint is directly reachable regardless.)

### Recommended engagement path

1. **Ship and stabilize the in-function path first.** It is the universal Vercel
   story and is already source-complete (`VercelCacheStore` shell family). This is
   what makes the chain work optional rather than blocking.
2. **Open a Vercel Build Output / DX conversation** with this doc and the six
   questions above, framed as: "we want to serve build-time PPR shells through the
   PoP chain the way Next does — is `chain` a supported third-party Build Output
   seam, and is the `x-nextjs-pre-render` split a contract we can emit?" Get a
   written answer on protocol stability **before** writing emitter code.
3. **De-risk with one throwaway spike:** hand-author a `.prerender-config.json` +
   fallback file for a single route and deploy it, to observe whether the PoP
   stitches a non-Next chain at all. This answers Q1/Q2 empirically for the cost of
   one deploy.
4. **Only after a green light:** implement build-time capture (prerequisite #1),
   the `vercel-output.ts` emitter, and the signed resume endpoint, behind a
   per-route opt-in flag, with dev+prod e2e that asserts the PoP actually stitches
   _and_ that a chain-absent route still serves in-function.

## Effort estimate

Rough sizing, assuming the in-function path is already shipped. "Blocking" means
later pieces depend on it.

| Piece                                                                                          | Effort | Notes                                                                                                |
| ---------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| Vercel protocol de-risking (conversation + one spike deploy)                                   | M      | **Blocking.** Answers Q1/Q2; gates everything below. Do not build without it.                        |
| Build-time shell capture pipeline (B segments -> `{ prelude, postponed }` at build)            | L      | Prerequisite #1; net-new, overlaps the deferred prerender work in `prerender-api-design.md`.         |
| Deterministic-capture guarantees for the build path                                            | S–M    | Mostly reusing existing masking/guard invariants under the build pipeline.                           |
| `vercel-output.ts` emitter (per-route `.prerender-config.json` + fallback file + config route) | M      | Extends `assemble()`; the fallback content-type is the riskiest byte.                                |
| Resume function output + launcher variant                                                      | M      | Second `.func` (or route) wired to `chain.outputPath`.                                               |
| Signed-blob resume endpoint (HMAC sign at build, verify at resume) + size caps                 | M      | **Security-critical.** The HMAC is load-bearing; do not ship the endpoint without it.                |
| reactVersion gate relocation into the signed envelope                                          | S      | Folds into the HMAC binding.                                                                         |
| Fallback wiring (chain-absent -> in-function)                                                  | S      | Largely "emit nothing new"; the in-function path already covers it.                                  |
| Dev + prod e2e (PoP stitch + fallback)                                                         | M–L    | Needs a real Vercel deploy in CI or a documented manual gate; the stitch cannot be asserted locally. |
