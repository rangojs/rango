# Vercel CDN-stitched PPR research

Status: **blocked by the middleware contract; not planned for the Vercel
preset.** Last source review: 2026-07-11.

This document records the Vercel/Next response-chain protocol and why Rango does
not emit it. It is protocol research, not an adapter specification. The shipped
Vercel path is in-function PPR inside the preset's streaming Node Function.

Read [`ppr-shell-resume.md`](./ppr-shell-resume.md) first. Its commit-point rule
is the deciding constraint here: every global and route middleware must finish
before Rango emits a shell byte.

## Outcome

The chain is technically close to Rango's shell entry, but it reverses the
security-critical order of operations.

Rango serves a shell HIT as:

```text
request
  -> global middleware
  -> route middleware
  -> authorization / redirect / ctx.dynamic() / response headers
  -> commit stored shell
  -> live Flight + React resume tail
```

Vercel's CDN-stitched shape is:

```text
request
  -> CDN commits stored shell
  -> CDN invokes chained resume function
  -> resume function streams the dynamic tail
```

Once the CDN starts the shell, Rango middleware cannot replace the response with
a redirect, 401, status, cookie, or header. Running the middleware in the resume
function is too late. This is not a performance tradeoff we can hide behind an
option; it changes the router's request semantics and access-control boundary.

A generic preset therefore must not emit CDN-first shell artifacts. Revisit only
if Vercel exposes a supported pre-shell execution hook that can:

1. run before any fallback bytes are committed;
2. short-circuit with the middleware's complete Response;
3. preserve global and route middleware ordering and onion semantics;
4. carry request context into the resume invocation without restricting it to a
   small serializable header surface.

An explicit "public route" opt-in could define a narrower contract, but it would
not be transparent Rango PPR and is not part of the current design.

## What is shipped instead

The universal path is source-complete:

- `ppr` is integral to the router; there is no shell middleware to mount.
- `VercelCacheStore` implements the shell family in Vercel Runtime Cache.
- Runtime producer A captures shells after a MISS.
- Build producer B captures `Prerender + ppr` URLs during `vite build`.
- Build shells are emitted as `__ps-*.js` modules behind a lazy
  `__shell-manifest.js` inside the RSC function bundle.
- Runtime and build entries use the same `ShellCacheEntry` and the same
  `serveShellHit` path.
- The Vercel preset emits one streaming Node Function plus static client assets.

The function handles every HTML/RSC request. Build-time PPR means "the first
function request is already a shell HIT," not "Vercel serves an HTML fallback
without invoking the function."

Relevant files:

| Concern                           | Owner                                         |
| --------------------------------- | --------------------------------------------- |
| Vercel Build Output               | `src/vite/plugins/vercel-output.ts`           |
| Build shell capture               | `src/vite/discovery/shell-prerender-phase.ts` |
| Build shell manifest read-through | `src/rsc/shell-build-manifest.ts`             |
| Middleware-before-shell commit    | `src/rsc/rsc-rendering.ts`                    |
| React capture/resume              | `src/ssr/index.tsx`                           |
| Vercel shell store                | `src/cache/vercel/vercel-cache-store.ts`      |

## Protocol facts from Vercel source

There are two related representations. Keep them separate.

### Next adapter output

The public Next adapter API exposes PPR routes through `outputs.prerenders[]`:

```ts
{
  type: "PRERENDER",
  pathname: string,
  pprChain?: { headers: Record<string, string> },
  fallback?: {
    filePath: string | undefined,
    postponedState: string | undefined,
  },
  config: {
    renderingMode?: "STATIC" | "PARTIALLY_STATIC",
  },
}
```

`PARTIALLY_STATIC` identifies PPR. The documented resume protocol sends a POST
with `next-resume: 1` and the opaque postponed state as its body. This is a
contract for platforms adapting **Next.js output**, not a public third-party
Vercel Build Output contract.

### Vercel Build Output

Vercel's published `@vercel/build-utils` source defines:

```ts
interface Chain {
  outputPath: string;
  headers: Record<string, string>;
}
```

`Prerender` accepts `chain?: Chain`. The current generic Build Output
deserializer reads a `<path>.prerender-config.json`, spreads its fields into a
`Prerender`, validates `chain.outputPath` and `chain.headers`, and retains the
chain without checking a Next.js framework identity. The build-result collector
also classifies a resolved chain target as PPR without receiving framework
metadata.

This source evidence establishes:

- a non-Next preset can write the field;
- the open-source parser accepts and preserves it;
- there is no open-source framework gate in parsing/classification.

It does **not** establish that Vercel's closed production provisioning/CDN path
will stitch a chain emitted by a non-Next builder. CLI upload acceptance is not
runtime CDN acceptance.

### Next's fallback framing

The `@vercel/next` builder writes one fallback byte sequence containing the
postponed state followed by the shell HTML. Its internal content type carries a
state length and the original HTML type:

```text
application/x-nextjs-pre-render; state-length=N; origin="text/html; charset=utf-8"
```

The only coherent interpretation is that Vercel's CDN slices the postponed
prefix, emits the HTML suffix, POSTs the prefix to `chain.outputPath`, and
appends the returned stream. That behavior matches the public Next platform
guide, but the exact media type and split/stitch behavior remain undocumented
as a third-party Build Output API primitive.

## Stability classification

| Surface                                                        | Status                                                 | Consequence                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Next adapter `PARTIALLY_STATIC`, `postponedState`, resume POST | Public Next adapter contract                           | Useful for hosting Next, not authority to emit Vercel Build Output |
| `Prerender.chain` / `Chain`                                    | Published source, absent from public Build Output docs | Parser support exists without a third-party platform guarantee     |
| `experimentalStreamingLambdaPath`                              | Explicitly experimental legacy shorthand               | Do not build new integration on it                                 |
| `application/x-nextjs-pre-render` split                        | Vercel/Next internal                                   | Can change without a documented compatibility promise              |
| Non-Next production stitching                                  | Unverified in closed infrastructure                    | Requires a live deployment proof and Vercel commitment             |

Even if every protocol question were answered positively, the middleware order
would still block transparent integration.

## Why the old adapter plan was rejected

An earlier version of this document proposed emitting, per build shell:

1. a concatenated postponed-state + HTML fallback;
2. a `.prerender-config.json` carrying `chain`;
3. a resume function wrapping `createShellResumeHandler()`;
4. routes that resolve the public URL to the prerender before the catch-all
   function.

Build producer B has since shipped, so the artifact pair exists. The proposal is
still invalid for three independent reasons.

### Middleware commits too late

This is the decisive reason. The CDN would emit a shared shell before auth,
redirect, tenant, rate-limit, preview, nonce, or `ctx.dynamic()` middleware can
decide the response.

Compiling Rango middleware into Vercel Edge Middleware is not a transparent
fix. Rango middleware may use Node dependencies, mutate arbitrary request
context consumed by loaders/handlers, and wrap downstream execution. A separate
edge stage cannot generally preserve those values or onion semantics.

### Resume failure cannot restore axis 1

The old proposal claimed a React/build version mismatch could fall back to a
complete render. It cannot: after the CDN sends the shell, a resume function
cannot replace the status, headers, or document prefix. It can only append bytes
or fail the already-committed stream.

Version signing and integrity checks would still be mandatory to avoid feeding
attacker-controlled postponed state into React, but they make failure detectable,
not recoverable.

### Revalidation is a separate cache system

Rango Runtime Cache tags/TTL and Vercel CDN/ISR state are independent. Updating
an in-function shell does not atomically update the CDN's shell/postponed pair.
The Next runtime has platform-specific cache update integration; Rango has no
documented third-party write seam for that pair.

## Full-response CDN caching is different

For a response that is entirely public and shared, HTTP
`Cache-Control: s-maxage=..., stale-while-revalidate=...` is the supported CDN
optimization. It caches the completed response, so a hit invokes no function
and sends no origin shell or tail bytes.

That is not PPR. It freezes the shell, loader output, resumed holes, Flight
payload, status, and headers together. It also bypasses every Rango middleware
on a CDN hit. Use it only where skipping the complete request pipeline is the
declared route contract.

See `skills/deployment-caching/SKILL.md` for the deployment matrix and safety
checklist.

## Front-proxy alternative

A programmable worker in front of Vercel can physically perform the splice, but
it has the same ordering problem. If it serves the shell before calling the
Rango origin, origin middleware is too late. Reimplementing selected auth logic
in the proxy duplicates policy and does not preserve arbitrary Rango middleware
semantics.

This alternative is valid only when the proxy itself owns the complete
pre-shell guard contract. It is not a generic Rango deployment mode.

## Conditions for revisiting

Do not implement the chain emitter based only on current source acceptance.
Revisit when all of these are true:

1. Vercel documents `chain` and the postponed-state framing for third-party
   Build Output producers.
2. A live non-Next deployment proves shell slicing, request-body forwarding,
   header forwarding, streaming append, and failure behavior.
3. Vercel supplies a pre-shell hook capable of preserving Rango middleware
   semantics, or Rango deliberately introduces a narrower public-route contract.
4. Shell/postponed revalidation has a documented atomic update path.
5. The resume endpoint has signed route/build/React-bound state and strict body
   limits.

Until then, the Vercel preset remains one streaming Node Function with
in-function PPR, and fully shared routes may independently opt into complete
HTTP CDN caching.
