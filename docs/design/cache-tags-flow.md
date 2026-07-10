# Cache Tag Invalidation — Flow (for review)

A visual walkthrough of how `cacheTag` / `cache({ tags })` + `updateTag` /
`revalidateTag` work, for human review. The whole system reduces to **one rule**:

> An entry is served only if **none** of its tags was invalidated at or after the
> entry's own `taggedAt` timestamp.

Nothing is hunted down and deleted in the Cloudflare case — invalidation records a
timestamp, and reads compare against it. That is why an entry written _after_ an
invalidation stays fresh automatically.

Source: `packages/rangojs-router/src/cache/cache-tag.ts`,
`cache/tag-invalidation.ts`, `cache/memory-segment-store.ts`,
`cache/cf/cf-cache-store.ts`. Consumer guide: `skills/caching` ("Tag-Based
Invalidation").

---

## Overview

```mermaid
flowchart LR
  W["① WRITE a tagged entry"] --> R["② READ it"] --> I["③ INVALIDATE a tag"]
  I -. "next read re-checks" .-> R
```

The three verbs a consumer touches:

| API                      | Where                           | Semantics                                                          |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------ |
| `cacheTag(...tags)`      | inside a `"use cache"` function | tag the entry at runtime                                           |
| `cache({ tags })`        | route DSL                       | tag the entry (static array or `(ctx) => string[]`)                |
| `updateTag(...tags)`     | server actions                  | **read-your-own-writes** — awaitable, immediate                    |
| `revalidateTag(...tags)` | route handlers / webhooks       | background (non-blocking) — hard-purge, next read re-renders fresh |

`cacheTag(...tags)` has a second, render-callable form: called during a request
render **outside** any `"use cache"` function, it records onto the request's
`_requestTags` instead of throwing. PPR shell capture and the document cache union
that set onto their entry, so a plain server component can tag the shell/full-page
artifact it renders into — `revalidateTag` then evicts it. On a route that is
neither PPR nor document-cached the tag records where nothing reads it (a no-op).

---

## ① WRITE — caching a tagged entry

```mermaid
flowchart TD
  A["set / setItem / putResponse (entry has tags)"] --> B["stamp taggedAt = now"]
  B --> C["store entry + its tags + taggedAt"]
  C --> D["L1 edge cache (+ KV L2 if configured)"]
```

The entry carries its tags and the moment it was cached (`taggedAt`). That
timestamp is the only thing reads need to make the freshness decision.

---

## ② READ — the freshness decision

```mermaid
flowchart TD
  A["Read an entry"] --> B{In cache?}
  B -- no --> MISS["MISS → render fresh + re-cache"]
  B -- yes --> C{Has tags?}
  C -- no --> SERVE["Serve cached"]
  C -- yes --> D["Get each tag's last-invalidated time<br/>(per-request memo → edge-cached marker → KV)"]
  D --> E{"Any tag invalidated<br/>at/after this entry's taggedAt?"}
  E -- yes --> MISS
  E -- no --> SERVE
```

- Untagged entries pay nothing — the tag check is skipped entirely.
- For tagged entries, the per-tag "last-invalidated time" (the **marker**) is
  resolved through a cascade so a hot route does not hit KV on every read:
  - **per-request memo** — one lookup per distinct tag per request;
  - **edge-cached marker** — only when `tagCacheTtl > 0`; serves the marker from
    the per-colo Cache API within that window;
  - **KV** — the global source of truth (memory store has no KV step; it deletes
    eagerly, so its reads do no tag work at all).
- In **purge mode** (`tagPurge` configured) an L1 hit consults only the
  per-request memo — eviction is the purge's job; see "Purge mode" below. The
  KV tier and PPR shells always run the full cascade.

---

## ③ INVALIDATE — `updateTag` / `revalidateTag`

```mermaid
flowchart TD
  A["updateTag(tags)  /  revalidateTag(tags)"] --> B["normalize tags, find configured store(s)"]
  B --> C{Which verb?}
  C -- "updateTag" --> D["await now (read-your-own-writes)"]
  C -- "revalidateTag" --> E["run in background (waitUntil)"]
  D --> F["store.invalidateTags(tags) — one batched call per store"]
  E --> F
  F --> G["Memory store: delete the tagged entries"]
  F --> H["CF store, per tag:<br/>• write KV marker = now (global truth)<br/>• write-through memo + edge marker (this colo = instant)"]
  H --> J{onRevalidateTag wired?}
  J -- yes --> K["ONE batched CF purge → evicts cached lookups in all colos (prompt)"]
  J -- no --> L["other colos converge when their cached marker TTL expires (≤ tagCacheTtl)"]
```

- The whole tag batch from one call is handed to each store at once, so the
  Cloudflare store fires `onRevalidateTag` **once** (one CDN purge request, which
  respects purge-by-tag rate limits) rather than once per tag.
- The colo that runs the invalidation is correct **immediately** (KV marker +
  write-through). Other colos either converge within `tagCacheTtl`, or — if a
  purge is wired — are evicted promptly by the batched purge.
- With `tagPurge` configured (purge mode), the CF store additionally awaits one
  batched purge-by-tag call that evicts the tagged **entries** themselves, and
  L1 hits stop checking markers — see "Purge mode" below.

---

## Why single-store (no companion tag store)

Memory and Cloudflare invalidate _oppositely_, both within their one store:

- **`MemorySegmentCacheStore`** is one process → `invalidateTags` **deletes** the
  tagged entries immediately. Reads do no tag work.
- **`CFCacheStore`** is per-colo and cannot be purged cross-colo eagerly → it
  records a **marker** (timestamp) in its _own_ KV namespace and reads compare
  against it. There is no separate tag-invalidation store to configure.

## Config knobs (CFCacheStore)

| Option               | Default          | Role                                                                                                             |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `kv`                 | —                | required for distributed invalidation; markers live here                                                         |
| `tagCacheTtl`        | `0` (off)        | edge-cache the markers for N s to cut KV reads; max extra cross-colo invalidation latency when no purge is wired |
| `tagInvalidationTtl` | none (no expiry) | how long a KV marker lives; must **exceed** max entry TTL+SWR                                                    |
| `onRevalidateTag`    | —                | batched purge hook; receives the namespaced `Cache-Tag`s to purge so cached lookups are evicted in every colo    |
| `tagPurge`           | —                | **purge mode**: L1 eviction delegated to purge-by-tag; L1 hits skip the per-read marker lookup (section below)   |

`tagCacheTtl` (small, a staleness ceiling) and `tagInvalidationTtl` (large, must
outlive data) size oppositely — see their JSDoc.

## Marker Cache-Tags (only when `tagCacheTtl > 0`)

Each edge-cached marker carries three namespaced tiers so a purge can target it:

```
rg:{ns}             # everything this store cached (deploy / nuclear reset)
rg:{ns}:lk          # all tag lookups
rg:{ns}:lk:{tag}    # this tag's lookup — the normal updateTag purge target
```

`{tag}` is `encodeURIComponent`'d, so commas/spaces can't corrupt the
comma-delimited `Cache-Tag` header. `onRevalidateTag` is handed the
`rg:{ns}:lk:{tag}` values to feed Cloudflare's purge-by-tag API.

> The purge API call cannot be exercised in miniflare; it is unit-tested with a
> mock purge client and needs deployed-worker verification.

## Purge mode (`tagPurge`) — skip the per-read marker lookup on L1 hits

Everything above buys read-time consistency by paying a marker lookup on every
tagged hit. Purge-by-tag is available on **all Cloudflare plans** (since April
2025 — it used to be Enterprise-only, which is why the marker system is the
default), so there is now a second way to run the L1 tier: evict invalidated
entries instead of checking on every read.

Configure `tagPurge` and the store flips the L1 contract:

- Every tagged data entry is written with namespaced entry `Cache-Tag` tiers
  (these are written **unconditionally**, so existing entries are already
  purgeable when you turn the mode on):

  ```
  rg:{ns}           # everything this store cached (deploy / nuclear reset)
  rg:{ns}:e         # all data entries
  rg:{ns}:e:{tag}   # entries carrying {tag} — the invalidation purge target
  ```

  Tokens are bounded against Cloudflare's limits: an over-long tag collapses
  to a deterministic hash token (`rg:{ns}:e:h:{fnv1a64}` — write-time and
  purge-time always agree; a hash collision over-purges, never serves stale),
  and a tag set whose joined header would exceed the 16 KB aggregate limit
  gets NO Cache-Tag header (warned once per namespace) rather than a failed
  L1 write. In KV-less purge mode that entry is NOT cached at all — with no
  tokens and no marker fallback it would be un-invalidatable, so it renders
  fresh instead.

- `invalidateTags()` **awaits** `tagPurge(cacheTags)` with one batched call
  (entry tags, plus the `rg:{ns}:lk:{tag}` lookup tags when `tagCacheTtl > 0`).
  Wire it to Cloudflare's purge API — `createCloudflareZonePurge({ zoneId,
apiToken })` is the ready-made client (chunked, rejects on API errors). A
  purge failure makes `updateTag()` reject, exactly like a failed KV marker
  write: with the read check gone, the purge IS the invalidation, so a dropped
  one must not report success.
- **L1 hits stop reading markers.** A surviving entry is trusted — an
  invalidated one would have been purged. Only the per-request memo is checked
  (synchronously, no KV read), so a request that ran `updateTag()` still masks
  its own not-yet-purged entries (read-your-own-writes). The trust is
  conditional on the entry actually carrying the store's entry Cache-Tags: an
  entry a purge cannot reach (written pre-upgrade, or its header omitted for
  the 16 KB overflow above) keeps the full marker check instead of serving
  stale until TTL.
- **KV L2 and PPR shells keep the marker check.** Purge cannot reach KV, and a
  baked build-manifest shell has no cache entry to purge — the markers (still
  written on every invalidation) remain their eviction mechanism. Keep `kv`
  configured for those tiers; without it, purge mode runs a supported L1-only
  store (previously tags-without-KV had no read-side effect at all).

What you trade: marker mode gives read-time KV consistency; purge mode's
cross-request invalidation latency is the purge propagation (Cloudflare quotes
sub-second Instant Purge), and account-level purge rate limits apply (Free plan:
5 calls/min). In exchange, tagged L1 hits drop the serial marker read (the
`markerMs` column below) and the `tagCacheTtl` machinery becomes unnecessary.

### Environments and previews (zone scoping)

Purge-by-tag clears **your zone**. Where your deployments live decides what an
invalidation reaches:

| Environment                                 | L1 (Cache API)             | Tag invalidation                                        |
| ------------------------------------------- | -------------------------- | ------------------------------------------------------- |
| Production on your zone                     | active                     | purge evicts it                                         |
| Preview on the **same** zone (any hostname) | active                     | purge is zone-wide → evicted too                        |
| `workers.dev` / `pages.dev` previews        | **inert** (CF disables it) | nothing to purge; KV tier still invalidates via markers |
| Preview on a **separate** zone              | active                     | needs its own `zoneId`/token, or falls back to TTL      |

Practical guidance: give previews their own KV namespace (markers and data stay
per-environment; the `v/{version}/` key prefix already partitions deploys), and
either scope `tagPurge` credentials per environment or leave `tagPurge` unset on
preview environments — they then run plain marker mode, which needs no
credentials.

## Tag-marker read latency, and why there is no in-isolate marker cache

The marker check is on the **serial path of every tagged hit**: a tagged read is
`match → await marker → await body` (`cf-cache-store.ts`, `get`/`getItem`). A
degraded namespace can pin the marker read up to `kvReadTimeoutMs` (default
170 ms) before it **fails open** — treats the marker as absent so the entry is
served — so one slow tag never turns a hit into a wrongful invalidation.

Measured on a real Cloudflare zone (`debug: true`, `tagCacheTtl: 0`, i.e. the
least-cached cascade memo → KV):

| condition                                             | `markerMs`           |
| ----------------------------------------------------- | -------------------- |
| warm — KV's per-colo edge cache serving the marker    | 1–6 ms (median ~2–3) |
| cold — genuine first touch, KV marker edge-cache cold | ~73 ms (n=1)         |

The cold blip is rare and sticky-warm — an 80 s idle did not re-cool it (KV's
per-colo edge cache outlives a minute).

**Rejected: an in-isolate module-level marker `Map`** (an L0 in front of the
cascade). It only speeds _warm-isolate repeats_, which are already the 1–6 ms
reads, and is cold exactly when reads are slow — a cold isolate starts with a
cold Map and still pays the full first read. `tagCacheTtl` (the per-colo Cache
API tier already in the cascade) is strictly better for that case: colo-shared
and surviving isolate churn, so one warm-up shields every isolate in the colo,
and during a transient KV slowdown at most ~1 KV read per `tagCacheTtl` window
per colo is exposed instead of one per request. The in-isolate layer is also not
cheap to get right — binding-keyed module state, write-through from
`invalidateTags`, a no-downgrade-on-settle guard, bounded eviction — correctness
work for a sub-3 ms warm-path win it mostly cannot deliver.

**If marker latency ever needs to drop further**, in order: (1) enable
`tagCacheTtl` (1–5 s) and re-measure `markerMs` _and_ `bodyReadMs` under
`debug: true` — the lever for the cold/slow tail; (2) only past that, parallelize
`marker ∥ body` so the hit path is `match + max(marker, body)` instead of
`match + marker + body` — worth the critical-path churn only if `bodyReadMs` on
tagged hits is large enough to be worth overlapping. The in-isolate Map is not on
this list.
