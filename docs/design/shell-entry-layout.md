# Shell entry layout: what a PPR shell HIT reads before its first byte

Status: **implemented** (issue #941). It shipped in six PRs, in this order:

| PR   | what                                                                               | section                 |
| ---- | ---------------------------------------------------------------------------------- | ----------------------- |
| #952 | decode the prelude once (native base64 where the runtime has it), 32 KB enqueue    | §3, §5                  |
| #953 | prelude-first `CFCacheStore` record; the marker read runs alongside the prelude    | §1, §4                  |
| #955 | `debugPerformance` rows for a shell HIT                                            | "Seeing it per request" |
| #958 | snapshot pruning                                                                   | §2                      |
| #959 | per-isolate shell memo                                                             | "The shell memo"        |
| #960 | tag-name hints, the stale-while-revalidate marker memo, and the fresh-reads cookie | "The tag-marker memo"   |

All four decisions ("Decisions") are made; the three that called for code are built.

Read `shell-fast-path.md` and `packages/rangojs-router/docs/design/ppr-shell-resume.md`
first. This doc is about one narrow question: how many bytes, parses, and
round trips a shell HIT pays before the browser sees its first byte, and how
to make that "one small cache read".

## What a HIT does now

A document HIT on `CFCacheStore`, in order:

1. The shell memo (`memo.shellMs`, per isolate). On a memo hit the tag-marker
   check is the only store I/O left, and with KV bound the marker memo
   usually answers it from memory.
2. Otherwise the Cache API match (KV on an L1 miss), with KV bound the marker
   reads of the key's hinted tags already started; then the frame head; then
   the marker check for the head's tags alongside exactly `pl` prelude bytes.
3. The commit: `openShellDocument` checks the postponed blob, and the raw
   prelude goes out in 32 KB chunks.
4. After the commit, the tail awaits the snapshot (the rest of the same body,
   read off the commit path), seeds the store, and resumes the holes.

`VercelCacheStore` reads its whole JSON envelope (the runtime cache has no
partial read) with the hinted marker reads alongside it, and memoizes the
decoded prelude with the entry. `MemorySegmentCacheStore` and custom stores
go through the public `getShell`, and the serve path decodes their base64
prelude once per HIT.

## Why

On Cloudflare, a storefront homepage with a 651 KB prelude sent its first byte
90-140 ms later than a hand-rolled shell server on the same account and colo
(issue #941). The floor (a trivial 404) was equal, isolates were warm, and
rango spent less CPU per HIT, so the gap was on the path to the flush. Before
enqueueing a single byte, a HIT:

1. matched the Cache API entry and read its whole body: a 3.3 MB JSON envelope
   of which the flush needs 651 KB;
2. `JSON.parse`d all of it, including a 2.4 MB capture snapshot the flush never
   reads;
3. with KV bound, awaited the tag-marker read (sequentially, after the body);
4. decoded the base64 prelude twice with a per-byte `charCodeAt` loop
   (`hasIntactShellPayload`, then `serveShellHit`);
5. enqueued the prelude as one 651 KB chunk, so an edge compressor had to
   compress all of it before emitting anything.

The comparison arm read one small entry (prelude text + ~28 KB of postponed
state), kept decoded bytes per isolate, and flushed.

## The reproduction

`tests/cloudflare-basic` `/ppr-large` (`src/pages/ppr-large.tsx`) rebuilds the
issue's shape on the real KV-backed `CFCacheStore`: three `"use cache"` chrome
components in the layout, a `"use cache"` catalog lookup the handler reads, and
a `"use cache"` body component. `/ppr-large/holes` adds a live loader under an
inline `<Suspense>`, so its entry carries a postponed blob.

| field (stored envelope)          | issue #941 | `/ppr-large` | `/ppr-large/holes` |
| -------------------------------- | ---------: | -----------: | -----------------: |
| whole envelope                   |     3.3 MB |     3,401 KB |           3,428 KB |
| prelude (decoded)                |     651 KB |       614 KB |             614 KB |
| prelude (base64 in the envelope) |     869 KB |       819 KB |             819 KB |
| postponed                        |     `null` |       `null` |              26 KB |
| snapshot                         |   2,405 KB |     2,582 KB |           2,582 KB |
| `doc:` segment record            |     998 KB |       995 KB |             995 KB |
| body component item              |     727 KB |       711 KB |             711 KB |
| data lookup item                 |     390 KB |       594 KB |             594 KB |
| 3 chrome items                   |     286 KB |       282 KB |             282 KB |

## Baseline measurements

Machine: Apple M-series, Node 22.18, workerd 1.20260708 via miniflare. Local
workerd's clock advances during CPU (Cloudflare's production clock does not),
but it is 1 ms-granular, so CPU numbers below batch 20 repetitions per sample.

**CPU per operation** (median of 15 samples, ms):

| operation on the `/ppr-large` entry                 | Node | workerd |
| --------------------------------------------------- | ---: | ------: |
| `JSON.parse` of the 3,401 KB envelope               | 2.39 |    3.15 |
| `new Response(text).json()` of the envelope         | 3.09 |    4.00 |
| `JSON.parse` of the snapshot/tail alone (2,582 KB)  | 2.11 |    3.05 |
| `JSON.parse` of a head with no snapshot (88 bytes)  | 0.00 |    0.00 |
| base64 decode, `atob` + `charCodeAt` loop (current) | 0.61 |    0.75 |
| the same decode twice (current HIT)                 | 1.16 |    1.40 |
| `Uint8Array.fromBase64` (workerd only)              |    - |    0.05 |
| `Buffer.from(b64, "base64")` (Node only)            | 0.06 |       - |
| `new Response(prelude).arrayBuffer()` (raw bytes)   | 0.04 |    0.10 |

**Compressed first byte** for the 614 KB prelude, fed as one write or as
fixed chunks with a flush after every chunk (what a streaming proxy does to
keep bytes moving). Node zlib, median ms:

| codec    | chunk  | first byte | total | out KB |
| -------- | ------ | ---------: | ----: | -----: |
| gzip-6   | single |       1.09 |  5.81 |    115 |
| gzip-6   | 16 KB  |       0.04 |  7.09 |    115 |
| gzip-6   | 32 KB  |       0.06 |  6.36 |    115 |
| gzip-6   | 64 KB  |       0.21 |  5.95 |    115 |
| brotli-4 | single |       2.30 |  2.39 |    114 |
| brotli-4 | 16 KB  |       0.06 |  3.78 |    115 |
| brotli-4 | 32 KB  |       0.07 |  3.09 |    114 |
| brotli-4 | 64 KB  |       0.22 |  2.81 |    114 |
| brotli-6 | single |       5.10 |  5.17 |    103 |
| brotli-6 | 16 KB  |       0.07 |  6.38 |    104 |
| brotli-6 | 32 KB  |       0.10 |  5.75 |    103 |
| brotli-6 | 64 KB  |       0.32 |  5.45 |    103 |

workerd's own `CompressionStream("gzip")` behaves like the single-write rows
more strongly: one 629 KB write produced its first output after 6 ms, equal to
the total; with 16 or 32 KB writes the first output arrived in under 1 ms.

**First byte on local workerd** (`vite preview`, cloudflare-basic, 40
interleaved rounds after warm-up, median [p25-p75] ms). Local Cache API and KV
are loopback calls into miniflare, so this under-represents Cloudflare I/O:

| request                           | baseline         |
| --------------------------------- | ---------------- |
| trivial 404 (floor)               | 3.6 [3.4-3.9]    |
| small shell HIT (`/ppr-drift`)    | 3.2 [3.0-3.5]    |
| large shell HIT (`/ppr-large`)    | 12.2 [11.5-15.2] |
| large + hole (`/ppr-large/holes`) | 16.4 [14.9-18.2] |

An `INTERNAL_RANGO_DEBUG` build of the same app attributes it:
`step shell-read 5.0-8.0ms` (Cache API `bodyReadMs` 5-8, `matchMs` 0, no marker
on this untagged route) and `step shell-hit 1.0-2.0ms` (two decodes + stream
setup).

**First byte under the issue's edge latencies** (a unit harness that drives
the real `handleRscRendering` HIT against a `CFCacheStore` whose fake Cache
API/KV inject the latencies #941 logged: `cache.match` 6 ms, the 3.3 MB body
streamed over 9 ms, tag-marker KV read 9 ms; CPU is real Node CPU; 25 rounds):

| entry                 | baseline         |
| --------------------- | ---------------- |
| untagged `/ppr-large` | 21.0 [20.5-21.2] |
| tagged `/ppr-large`   | 29.8 [29.5-30.1] |

The model reproduces the issue's structure: match + whole-body read + parse +
decode, plus a sequential marker read when the shell is tagged. Node lacks
`Uint8Array.fromBase64`, so Node numbers keep the loop decode unless the
harness installs a native shim (it can, to model workerd).

## Measurement history

Same harnesses as the baseline, each row measured when its PR landed, on top
of the rows above it. Local workerd: 5 runs x 40 interleaved rounds per row,
pooled (200 samples), each large-shell sample minus the floor request of the
same round, which cancels most of the machine's load drift. Edge model: the
Node harness with workerd's native base64 installed.

| change                            | local workerd `/ppr-large` over floor | local workerd `/ppr-large/holes` over floor | edge model, untagged | edge model, tagged |
| --------------------------------- | ------------------------------------- | ------------------------------------------- | -------------------- | ------------------ |
| baseline                          | 13.2 [10.4-15.8]                      | 13.5 [11.5-15.1]                            | 21.0 [20.5-21.2]     | 29.8 [29.5-30.1]   |
| decode once, 32 KB chunks (#952)  | 12.6 [9.9-14.0]                       | 12.4 [10.8-13.6]                            | 20.1 [19.5-20.6]     | 29.6 [29.2-29.9]   |
| prelude-first entry (#953)        | 3.6 [2.6-4.1]                         | 1.0 [0.6-1.3]                               | 8.3 [8.3-8.4]        | 17.5 [16.9-17.7]   |
| shell memo hit, 2 s window (#959) | 1.3 [0.7-2.0]                         | -0.3 [-0.8-0.2]                             | 0.2 [0.1-0.2]        | 10.2 [10.2-10.3]   |
| shell + marker memo hit (#960)    | -                                     | -                                           | -                    | 0.1 [0.1-0.2]      |

The decode-once gain is the decode work (1.4 ms of per-byte loop in workerd);
its compressed-first-byte gain does not show in these uncompressed numbers
(see the compression table). The prelude-first entry removes the 3.4 MB read
and parse from the first-byte path; with a tagged shell the marker read (9 ms
in the model) then set the floor, overlapping the match-plus-prelude read
instead of following it. A memo hit removes the store read as well, which
left a tagged memo hit with the marker read alone; the marker memo removes
that too (its other rows, store reads and the fresh-reads cookie included,
are in "The tag-marker memo"). The local workerd memo row is with the tail's
macrotask yield ("The shell memo" below): without it, memo hits measured 5.9
and 6.7 ms over the floor.

### Seeing it per request

Under `debugPerformance` the HIT's store read is broken into rows
(`ppr:shell-memo`, `ppr:shell-match`, `-head`, `-prelude`, `-marker` under
`ppr:shell-read`, after a `ppr:shell-l1-miss` row when a KV hit follows a
Cache API miss, then `ppr:shell-open` and `ppr:shell-commit`), and the work
after the commit prints as a `shell tail` line with the snapshot's bytes and
records per family (`skills/observability` "Reading a PPR shell HIT",
`packages/rangojs-router/docs/telemetry.md`). The byte and chunk counts are
there because a deployed worker's clock does not advance during CPU work:
`ppr:shell-open` and the snapshot parse read 0 ms there, and the sizes are
what move when a change moves the cost.

## What a HIT needs, and when

| field                                | needed before the first byte | needed by the tail              |
| ------------------------------------ | ---------------------------- | ------------------------------- |
| prelude                              | yes (it is the first byte)   | no                              |
| `reactVersion`, `buildVersion`       | yes (validity gate)          | no                              |
| `navigationOnly`                     | yes (document gate)          | no                              |
| `createdAt`, tags, `taggedAt`        | yes (marker check, SWR)      | no                              |
| `postponed`                          | parse check (corrupt ⇒ MISS) | yes (`resume()`)                |
| `initialTheme`                       | no                           | yes                             |
| `handlerLiveHoles`, `transitionWhen` | no                           | yes (fast-path arming)          |
| `docKey`                             | no                           | partial replay only             |
| `snapshot`                           | no                           | yes (seeded store, loader seed) |

Everything but the snapshot is small. The snapshot is 75% of the bytes and
none of the first-byte work.

## 1. Split the entry: prelude first, snapshot behind it

### The shape: one record, prelude-first

The CF entry is one body laid out in the order the HIT consumes it
(`src/cache/cf/cf-shell-frame.ts`):

```
"RSH1"                 4-byte magic (format version)
8 hex digits           head length
head JSON (UTF-8)      rv, bv, c, s, e, t, ta, i, dk, pr, lh, tw, no, po, pl, sl
prelude bytes          pl raw bytes, no base64
snapshot JSON          the rest of the body: exactly sl bytes (0 when there is none)
```

A document HIT reads the head, starts the tag-marker read, reads exactly `pl`
prelude bytes, awaits the marker, and commits. The snapshot bytes are still
streaming in; `readShellDocument` hands the tail a promise that reads and
parses the rest of the same body. That read starts when `readShellDocument`
resolves, so it runs off the commit path rather than strictly after the
commit, and it is registered with `waitUntil`: a read nobody serves still
finishes its KV-to-L1 promotion or its corrupt-entry eviction.

Why an ASCII length and not a binary one: every byte of the frame is then
UTF-8 text whenever the prelude is, and React's HTML through `TextEncoder`
always is. KV stores the frame as a string, because the public
`KVNamespace` shape the store accepts declares `put(key, value: string)`, and
`kv.get(key, { type: "stream" })` returns exactly the frame's bytes. A binary
KV value would have meant widening that public type. `shellFrameToText`
decodes with `fatal: true`, so a prelude that is not valid UTF-8 fails the KV
write loudly instead of corrupting it.

You might ask why not two records (prelude record + snapshot record, fetched
in parallel), which is what the issue proposed. Two records have to be paired:
a reader can see generation N's prelude with N+1's snapshot during a write, when
the Cache API evicts one record and not the other, or when KV propagates two
keys to a remote colo at different times (KV is eventually consistent per key,
up to ~60 s). A mismatch discovered before the commit is a miss; one discovered
after it (the only way to keep the snapshot off the first-byte path) serves a
prelude against the wrong pins, which is the hydration-mismatch class the
snapshot exists to prevent. The only way to catch it pre-commit is to read the
snapshot record's generation first, which on Vercel (no metadata-first read)
means reading all of it. One prelude-first record is atomic by construction
(a Cache API entry and a KV value are written and read whole), and a streamed
body gives the same "the snapshot is not on the first-byte path" property with
no pairing, no generation ids, and no mismatch handling.

What it does not buy: the snapshot's bytes still travel with every read. That
is what snapshot pruning (§2) addresses.

### Per store

| store                      | layout                                                                                                                                           | first-byte read                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `CFCacheStore` (Cache API) | frame body; `Content-Type: application/octet-stream` (was `application/json`), the same cache headers (max-age, stale-at, expires-at, Cache-Tag) | match + head + prelude (~0.64 MB), marker in parallel                                                                      |
| `CFCacheStore` (KV)        | the frame as a string; read with `{ type: "stream" }`                                                                                            | same, under one `kvReadTimeoutMs` for the open, head, and prelude; the snapshot is read off the commit path, then promoted |
| `VercelCacheStore`         | JSON envelope (base64 prelude, snapshot inline)                                                                                                  | the whole entry; the prelude decoded once per memoized shell (see below)                                                   |
| `MemorySegmentCacheStore`  | holds the entry object                                                                                                                           | no I/O and no parse; one decode per HIT                                                                                    |
| custom stores              | the public `getShell`/`putShell` contract                                                                                                        | `getShell`, then one decode per HIT                                                                                        |

Vercel's runtime cache client returns a parsed value (`getCache().get()` does
the fetch and the JSON parse); there is no way to read the head of a value
without reading all of it, so the Vercel store keeps its envelope. Its first
byte comes down instead through the shell memo, which keeps the decoded
prelude with the memoized entry, and the tag-name hints, which start the
marker reads alongside the entry read ("The shell memo", "The tag-marker
memo"). The memory store has nothing to read.

### The contract stays as it is

`SegmentCacheStore.getShell` / `putShell` and `ShellCacheEntry` are public
(`@rangojs/router/cache`) and custom stores implement them, usually by JSON
serializing the entry. Changing `ShellCacheEntry.prelude` to bytes, or adding
a required split read, would break every custom store. So the public contract
does not change: `putShell` still receives a base64 `prelude`, and `getShell`
on `CFCacheStore` reads the framed body and returns the same `ShellCacheEntry`
it always did (the prelude re-encoded with `toBase64`, 0.05 ms). The first-byte
path uses an `@internal` optional store method,
`readShellDocument(key, { tagHints })`, that only built-in stores implement
and the serve path (`readShellEntry` in `rsc-rendering.ts`) prefers when
present. `tagHints` is the route's `ppr.tags`, known before the entry is read:

```ts
interface ShellDocumentRead {
  entry: ShellCacheEntry; // no prelude, no snapshot
  prelude: Uint8Array; // raw bytes
  shouldRevalidate?: boolean;
  snapshot: Promise<ShellSnapshotRecord[] | undefined>; // never rejects
  stats?: ShellReadStats; // debugPerformance rows, when on
}
```

`openShellDocument` (`src/rsc/shell-serve.ts`) is the one pre-commit gate for
both reads. For a `readShellDocument` result it checks the postponed blob; for
a `getShell` entry it runs `hasIntactShellPayload` (a string prelude and a
parseable postponed blob, the check partial replay uses on its own) and then
the one decode.

**Decided (decision 4): it stays internal.** Exposing `readShellDocument`
would freeze this internal record layout as public API. Custom stores keep the
whole-entry `getShell` read and still get the single decode and the pruned
snapshot. If a custom-store author asks for a prelude-first read later,
the public shape to offer is a split by key: `getShell` for the head and
prelude, then a separate `getShellSnapshot`, with a stated pairing and
generation rule for the two records. Not `readShellDocument` as it is.

### Failure handling

- Before the commit (bad magic, head that fails `isShellFrameHead`, fewer
  than `pl` prelude bytes, a head+prelude read over `edgeReadTimeoutMs`, or
  over `kvReadTimeoutMs` counted from the KV open): exactly the previous L1
  corruption/timeout handling (heal, fall through to KV, then MISS).
- After the commit (a snapshot part that is not `sl` bytes long, which catches
  a body truncated exactly at the prelude's end; snapshot bytes that fail to
  parse; a snapshot read over `kvReadTimeoutMs`): the snapshot promise
  resolves `undefined` and the tail runs without pins, which is the existing
  no-snapshot path (the same posture as an over-cap snapshot,
  `maxSnapshotBytes`). A length mismatch or parse failure also evicts the
  entry from both tiers and reports `cache-corrupt`, so the next request
  recaptures. (With the whole-envelope read before #953, a corrupt or slow
  snapshot made the read a MISS.)
- `getShell` (partial replay, custom callers) has no commit to protect, so the
  same snapshot failures make it return null instead of an entry without its
  pins.

### Build-time shells

Producer B's `__ps-*.js` asset modules keep the `ShellCacheEntry` JSON. They
are immutable and already memoized per isolate after the first read
(`validatedManifestRecord`), so the only per-HIT cost is the one decode.

### Old entries

Every deploy changes `buildVersion`, and `isValidShellHit` treats an entry from
another build as a miss, so an old-format entry can never be served by new
code. The framed layout also moves to a new key namespace (`shell2:`), so new
code never parses an old JSON body (no `cache-corrupt` noise after a deploy)
and a rollback never parses a framed body. Old keys age out by their TTL. No
migration is needed.

## 2. Record only what a HIT reads

**Implemented** (`pruneShellSnapshot`, `src/cache/shell-snapshot.ts`; the
decision in `snapshotReaders`, `src/rsc/shell-capture.ts`).

The snapshot used to be "exactly the set of cache-store reads the capture
render performed". On a document HIT that takes the fast path (the tail HITs
the implicit `doc:` record and replays the handler layer), the handlers never
run, so the item and response records that only handler/render code read are
never consulted. On `/ppr-large` that was 1,587 KB of the 2,582 KB snapshot.
The job is to drop exactly those, and nothing a HIT or a navigation can still
read.

### Who reads which family

| reader                                | segment |     item     |   response   | loader |
| ------------------------------------- | :-----: | :----------: | :----------: | :----: |
| document HIT tail, fast path armed    | `doc:`  | loaders only | loaders only |  yes   |
| document HIT tail, fast path declined |   yes   |     yes      |     yes      |  yes   |
| partial navigation replay             |   yes   |      no      |      no      |   no   |

Partial replay installs `SeededShellStore(..., { segmentsOnly: true })`, so it
never reads the item, response, or loader families (`rsc-rendering.ts`,
`matchPartialWithPprReplay`). Intercepts over a ppr route only render on
partial navigations, so they follow the same row.

### The rules

**R1, navigation-only entries.** A `navigationOnly` entry is never served as a
document (`shellServePlan` skips it) and is only read by partial replay, which
reads the segment family only. Keep segment records, drop the rest.

**R2, document entries.** Drop an item or response record when all of these
hold:

1. **R2.1** the capture recorded the implicit doc record (`docKey` is set AND
   the snapshot carries that record with at least one segment), and the entry
   is fast-path eligible (`!handlerLiveHoles && !transitionWhen`), so every
   HIT's tail replays the handler layer from that record;
2. **R2.2** the store has no `keyGenerator`, so the doc key a HIT computes
   (`doc:` + host + path + route params + the same sorted, filtered search the
   shell key uses) is the key the capture recorded;
3. **R2.3, dropped** (decision 3): the capture masked no live-lane loader;
4. **R2.4** no read or write of that record's key happened inside a loader
   scope during the capture (bake-lane loaders re-run on every HIT and must
   keep their pins); and
5. **R2.5** the implicit doc scope was the route's scope at capture
   (`_shellImplicitCache.routeDocScope`, set where
   `resolveShellImplicitCacheScope` mints it for a route that derived no
   scope).

A build-time capture (producer B) keeps every record: it runs against
`http://build.invalid`, so its `docKey` names a host no request computes, and
its HIT tails miss the record and re-run the handlers.

Segment and loader records are always kept.

Why each condition:

- (R2.1) With the fast path declined the tail re-runs handlers, and they read
  items; so do tails of entries that never recorded a doc record. `docKey`
  alone is not enough: the doc scope's `cacheRoute` sets it before its
  deferred write, which can still decline to store or miss the write-settle
  deadline.
- (R2.2) A store `keyGenerator` can fold request data into the doc key
  (`x-user-segment`), so a visitor's tail can miss the recorded doc record and
  re-run handlers.
- (R2.3, dropped) A live loader under a hole reads the store on every HIT.
  Before pruning, a key it shared with the shell was pinned for it too ("seeded
  everywhere"). With the record dropped, that hole shows live data for the key
  while the shell shows capture data. The maintainer chose that semantic: holes
  are the live lane (decision 3). The live read costs one store read after the
  commit: 6.95 ms for a 1 KB item, 9.13 ms for 594 KB, 19.33 ms for 594 KB
  tagged in the #941 edge model, against 0.001-0.002 ms for a seed hit. It is
  never on the first-byte path.
- (R2.4) The recording store sees every `"use cache"` call: each call does a
  `store.getItem` before any in-flight join (`cache-runtime.ts`), so marking
  the key as loader-read on every access (hits and misses, in
  `isInsideAnyLoaderScope()`) is complete, including a loader that joins a
  handler's in-flight leader. Loader-cache reads (`loader-cache.ts`) run inside
  the same scope.
- (R2.5) With a route-derived `cache()` scope the capture still records the doc
  record and sets `docKey` (`recordShellCaptureDocRecord`), but the document
  HIT tail never consults it: `resolveShellImplicitCacheScope` returns the
  route's scope, and the doc-record fallback in `withCacheLookup` is gated on
  `onExplicitHit`, which only partial replay sets. The handlers re-run on an
  explicit miss, a `condition()` bypass or a request-dependent `key()`, and
  read items. The mark lives where the doc scope is minted for the route, not
  where `recordShellCaptureDocRecord` composes it.

**Residual B (accepted).** If the doc record fails to decode on a HIT
(`CacheScope` reports `cache-corrupt` and evicts the key it read), the tail
re-runs the handlers against live values for the items the capture pruned.
That tail can disagree with the prelude; React repairs the mismatch
client-side. The HIT's fast-path marker sets `onCorrupt`, which schedules a
recapture, so the next requests are served from a sound entry. Before this
change nothing evicted or recaptured a document shell in that state: every HIT
re-ran the handlers until the entry expired.

The entry records what was dropped (`ShellCacheEntry.prunedRecords`, the CF
frame head's `pr`, the Vercel envelope's `pr`), and the HIT tail timing prints
it next to the kept records: `records=segment:1 pruned=item:5`.

### Measured

`tests/cloudflare-basic`, `vite preview` (workerd, KV-backed `CFCacheStore`),
read from the `ppr-tail` Server-Timing row. "Before" is the same build with the
prune step disabled.

| entry                           | snapshot before | snapshot after | stored frame before | stored frame after |
| ------------------------------- | --------------: | -------------: | ------------------: | -----------------: |
| `/ppr-large` (production)       |     2,643,864 B |    1,018,799 B |         3,272,863 B |        1,647,811 B |
| `/ppr-large/holes` (production) |     2,644,222 B |    1,019,145 B |         3,301,113 B |        1,676,049 B |
| `/ppr-large` (dev)              |   16,960,162 B¹ |    1,374,662 B |                   - |                  - |

¹ Over the 8 MiB `maxSnapshotBytes` cap, so the dev entry was stored without a
snapshot and every dev HIT re-ran the handlers (tail `first-html` 229 ms against
3 ms after).

The stored frame is the 12-byte prefix + head + prelude + snapshot. The tail's
`tail=` bytes are equal before and after (1,031,849 B for `/ppr-large`), and
the tail reads 0 item records. Locally the snapshot read went from 4 to 2 ms and
its parse from 3 to 2 ms; on the edge the saving is the 1.6 MB the tail no
longer reads and parses per HIT.

### Proof by tests, not reasoning alone

- `src/rsc/__tests__/shell-snapshot-prune.rsc-test.tsx` drives a MISS, the
  real capture, and a document HIT through `handleRscRendering` with real
  Flight. A covered capture stores only its doc record; its HIT reads no item
  and its body (prelude + tail Flight payload) is byte-identical to the HIT
  served from the unpruned snapshot. The keep cases (R2.5 with an explicit
  miss, a `condition()` bypass and a custom `key()`; R2.2; R2.1 with a
  handler-invoked loader) re-run handlers that read the capture values from the
  seed. R2.4 keeps a bake-lane loader's item. The shared-key case shows the
  shell's capture value and the hole's live one. Partial replay of a pruned
  entry is byte-identical to the unpruned one. A corrupt doc record recaptures.
- `src/rsc/__tests__/shell-capture.test.ts` ("snapshot pruning") flips one
  condition per test, plus R1 and the size cap measuring the pruned snapshot.
- Removing any one condition from `snapshotReaders` turns its keep tests red;
  removing the prune step turns the pruning, shared-key, partial-replay and
  residual-B tests red.
- e2e, dev + production: `/ppr-large`, `/ppr-large/holes` and
  `/shell-cache/large` report `records=segment:1 pruned=item:N` and hydrate
  with zero errors; `/ppr-shared-key` and `/shell-cache/shared-key` keep the
  shell's capture stamp while the hole moves on, with zero hydration errors.

The unit test pins the tail's Flight payload, not the resumed HTML: it stubs
SSR, because `react-dom/server` does not load under the react-server
condition the Flight test project runs with. The resumed HTML is identical
anyway, because `resume()` gets identical inputs: the same stored postponed
state and a byte-identical tail Flight payload. The evidence on the real
stack: the `/ppr-large` HIT's tail (resumed HTML with its inlined Flight
payload) was 1,031,849 bytes long with and without pruning (the "Measured"
table's build), and the dev + production e2e above hydrate the pruned HITs
with zero errors.

### By copy vs. by reference

The alternative is to store the doc record by reference (content hash or
generation) and keep a copy of nothing. It is worse on both axes that matter
here: the tail must make one more store read to fetch the record, on the tail's
critical path; and the referenced record can be evicted independently of the
shell (Cache API LRU), turning a HIT into a post-commit miss that re-runs
handlers. Those handlers then need the item records, so by-reference cannot
drop them. Pruning by copy removes the bytes with neither cost.

## 3. Decode once

- `Uint8Array.fromBase64` / `toBase64` where the runtime has them (workerd:
  0.05 ms for the 614 KB prelude against 0.75 ms for the loop), the loop
  elsewhere (Node 22 and 24 have neither method). Their outputs and error
  behavior match `btoa`/`atob` (workerd probe: 0 mismatches over 300 lengths;
  the same inputs throw). `cf-base64.ts` looks the methods up per call, so a
  polyfill installed after import is used.
- The document HIT's integrity gate is the decode itself
  (`openShellDocument`): the bytes it produces are the bytes `serveShellHit`
  enqueues. `hasIntactShellPayload` becomes a structural check (a string
  prelude, a parseable postponed blob), which is all partial replay needs: it
  never serves the prelude, and its gate used to decode it once per
  navigation (unit test: 1 decode before, 0 after).
- A separate per-isolate memo of decoded preludes is not worth it: with
  native decode the whole decode costs 0.05 ms, and a shared buffer has to be
  copied per response anyway (an enqueued chunk must own its buffer). The
  memo that pays is the one that skips the store read, which is a freshness
  decision ("The shell memo", decision 1). It holds the raw prelude on
  `CFCacheStore` and the decoded one on `VercelCacheStore`.

## 4. The tag-marker check

With KV bound, a shell L1 hit checks the KV generation markers of its tags
(the capture-start/purge race in `ppr-shell-resume.md`). Before #953 that
read started after the whole body was read and parsed.

| option                                                 | first-byte gain (issue numbers)                      | staleness added                                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A. start the marker read as soon as the head is parsed | min(marker, prelude read) ≈ 2-9 ms                   | none                                                                                                                       |
| B. per-isolate marker memo for N ms                    | marker read (≈ 9 ms) on memo hits                    | up to N ms after an `updateTag` in another isolate                                                                         |
| C. serve, then check the marker after the flush        | marker read (≈ 9 ms) on every HIT                    | at least one stale document per isolate after an invalidation; breaks `updateTag` read-your-own-writes for a following GET |
| D. fold the tag generation into the shell key          | none by itself (the generation still has to be read) | none                                                                                                                       |

**Shipped: A, then B in a stale-while-revalidate form.** The marker read
starts as soon as the head is parsed, runs in parallel with the prelude read,
and is awaited before the commit (#953). B was first declined in any form,
even opt-in, so that with KV bound `updateTag` / `revalidateTag` stay
immediate across isolates; the one knob trading marker freshness for latency
was the opt-in `tagCacheTtl` (a per-colo Cache API copy of each marker,
documented as a staleness ceiling). Once the shell memo left a tagged memo hit
with nothing but its marker read, decision 2 was revised: plain reads get a
per-isolate marker-value memo served stale-while-revalidate, reads after a
mutation stay correct, and tag-name hints start the marker reads before the
store match resolves (#960, "The tag-marker memo"). C weakens the `updateTag`
guarantee; D gains nothing on its own.

## 5. Chunked prelude enqueue

`serveShellHit` enqueues the prelude in 32 KB chunks
(`SHELL_PRELUDE_CHUNK_BYTES`), each a copy that owns its buffer. From the
compression table: 32 KB brings the first compressed byte to 0.06-0.10 ms
(from 1.09-5.10 ms for one write) and costs 0.55-0.70 ms more total
compression; 16 KB saves another 0.02-0.03 ms of first byte for 1.3-1.4 ms
more total; 64 KB costs 0.15-0.22 ms more first byte for 0.1-0.4 ms less
total. 32 KB is the knee. Whether Cloudflare's edge compressor flushes per
upstream write is not observable locally; the local numbers show the mechanism,
not the edge's constants.

## Other findings from the investigation

**A. An async server component in the handler's tree is not held by the
capture gate.** `holdUntil` (`shell-capture.ts`) waits for top-level handle
pushes and bake-lane loader containers; an async component the handler
renders without awaiting is in neither, so a slow read inside it can arrive
after the byte-quiet window. With no `<Suspense>` above it the root pins and
the capture ends `no-shell`. Holding the gate "until route segment roots
settle" has no cheap signal (Flight exposes no per-element settlement), and the
one full-settlement signal the capture has, the doc record's own
serialization, deep-settles promises, so holding on it would bake PHYSICS
holes (a pending handler promise under the consumer's own Suspense) into the
shell and break the hole doctrine. **Documented, not fixed** (#952):
`ppr-shell-resume.md` describes the case beside the hole doctrine table ("One
shape sits between (b) and (c)"), `skills/ppr` lists it under "Not in the
table", the no-shell warning names it, and finding B's stack points at it. Holding
the gate for a late segment-root row was prototyped with the capture
readiness gate (#954) and rejected: the gate admits bytes, not rows, so a
physics promise that settled during the hold was baked into the prelude.

**B. The no-shell warning names the component that pinned the root.** React
passes each aborted task's `componentStack` to `prerender`'s `onError`
(`finishAbortedTask`, react-dom 19.3). The capture used to swallow those
reports. In dev, the capture keeps the first few stacks and the once-per-key
no-shell warning prints them, which is exactly what found both causes in the
issue.

**C. First-MISS read budgets on cold colos.** The 25 ms L1 lookup, 20 ms L1
body, and 170 ms KV budgets are already per-store options
(`edgeLookupTimeoutMs`, `edgeReadTimeoutMs`, `kvReadTimeoutMs`,
`skills/caching/SKILL.md` "Latency budgets"). No code change: the
prelude-first entry shrinks what the L1 body budget has to cover from the
whole 3.3 MB envelope to the head + prelude, which is the part of this that
cold colos hit.

## The shell memo

A warm isolate that serves the same shell many times a second re-reads and
re-parses the same entry on every HIT. The memo (`src/cache/shell-memo.ts`)
keeps the last fresh read per key for `memo.shellMs` and serves the next HITs
from memory. It is on by default in `CFCacheStore` (one memo per isolate) and
`VercelCacheStore` (one per runtime-cache handle, so the handle must be
created once per process, not per request).

What a memo hit still does, and what it may serve:

- The tag-marker check runs on every read, memoized or not, and is awaited
  before anything is returned, so with KV bound
  `updateTag()`/`revalidateTag()` reject a memoized shell on the next request
  in every isolate. On Vercel the check reads rango's `tm` markers, which
  `invalidateTags` writes; a bare platform `expireTag` that skipped rango
  writes none, so a memoized shell survives it until the window passes.
- The isolate that invalidates drops its own copies, and keeps reads still in
  flight from memoizing them again. That second part is scar tissue: in
  KV-less purge mode a HIT that read the L1 entry while the purge call was
  running memoized it after `invalidateTags` had cleared the memo, and the
  memo-hit check (only the request's own marker memo, there being no KV)
  let the mutating user's next request on that isolate get the purged shell.
  `RecentTagInvalidations` records each invalidated tag from the start of
  `invalidateTags` until one window after it settles (at least the 2 s
  default, far above the 170 ms snapshot read budget of a read in flight);
  while it lives, a shell tagged at or before the invalidation is neither
  memoized nor served from the memo. It only adds rejections. Vercel has no
  such race: every memo hit reads the markers, which land before
  `invalidateTags` resolves (unit tests hold the marker write and the
  `expireTag` call to show it).
- Up to one window stale, in another isolate: a newer capture of the same key
  (the isolate that captured replaces its copy in `putShell`); in KV-less
  purge mode a purged shell, because the purge reaches the stored entry and
  not other isolates' memos, and the memo hit has no marker to read. That
  includes the mutating user's next request when it lands on another isolate
  (the contract suite pins it: "another isolate serves a purged shell until
  its window passes"). On Vercel, an invalidation from another region: the
  `tm` markers are a regional `cache.set` and only `expireTag` is global
  (`vercel-cache-store.md`), so a region that memoized the shell before the
  invalidation finds no marker and serves it until its window passes, where
  without the memo `expireTag` removed the entry within about 300 ms. The
  mutating user is not served either: the fresh-reads cookie ("The
  tag-marker memo") sends their requests past the memo. An app where every
  user's next request must see an invalidation sets
  `memo: { shellMs: 0, markerFreshMs: 0 }` (the marker memo alone serves an
  invalidated shell to other users for up to `markerMaxStaleMs` with KV).
- Only a fresh shell whose snapshot read completed is memoized; a shell that
  turns stale is dropped and read from the store, so SWR recapture scheduling
  stays with the store read. Different builds never share an entry (the memo
  key carries the Cache API URL with its version path; the version gates
  still run on the returned entry).
- The memo holds what the store holds: after snapshot pruning (§2), the
  pruned snapshot and `prunedRecords`, counted at their stored size. A HIT
  whose doc record fails to decode drops the key's memo entry
  (`SegmentCacheStore.dropShellMemo`, internal) before it schedules the
  recapture: the memoized copy has the same record, while the store may
  already hold another isolate's recapture.

Measured before snapshot pruning, on the unpruned 3.3 MB entry
(`CFCacheStore`: edge model with the #941 latencies and workerd's native
base64; `VercelCacheStore`: a model of 6 ms per runtime-cache `get`, entry and
each tag marker, not measured on Vercel, on Node without native base64):

| read                                  | untagged first byte |   tagged first byte |
| ------------------------------------- | ------------------: | ------------------: |
| `CFCacheStore` store read (#953)      |    8.3 [8.2-8.5] ms | 17.3 [16.4-17.4] ms |
| `CFCacheStore` memo hit               |    0.2 [0.1-0.2] ms | 10.2 [10.2-10.3] ms |
| `VercelCacheStore` store read (model) | 10.8 [10.7-10.9] ms | 17.9 [17.6-18.4] ms |
| `VercelCacheStore` memo hit (model)   |    0.1 [0.1-0.2] ms |    6.9 [6.9-6.9] ms |

The Vercel store reads the whole entry, then its tag markers, so its tagged
memo hit is one marker read; its store read includes the loop decode of the
prelude, which a memo hit skips (the memo keeps the decoded prelude).

Starting the marker read earlier on a memo hit buys nothing measurable: it is
already the first thing the hit does, and everything after it (the integrity
check and stream setup) is the 0.2 ms of the untagged row, so overlapping it
could save at most that.

Hit rate of the real `ShellMemo` under Poisson arrivals, per isolate and per
key (a miss refills after a 10 ms read; 2,000 simulated seconds):

| requests/s | 1 s window | 2 s window | 5 s window |
| ---------: | ---------: | ---------: | ---------: |
|        0.1 |       8.2% |      15.5% |      33.8% |
|        0.5 |      31.4% |      49.3% |      69.9% |
|          1 |      50.3% |      66.3% |      83.1% |
|          2 |      66.4% |      79.9% |      90.6% |
|          5 |      82.8% |      90.5% |      96.1% |
|         10 |      90.1% |      94.8% |      97.8% |
|         50 |      97.1% |      98.5% |      99.4% |

That is `λW / (1 + λW)`. Memory (Node 22 heap, `--expose-gc`): a
`CFCacheStore` memo holding `/ppr-large` holds 3,448 KB (2,834 KB of parsed
snapshot on the heap plus the 614 KB prelude buffer) for 3,196 KB counted
(prelude plus snapshot JSON), 1.08x. A `VercelCacheStore` memo keeps the
parsed envelope (base64 prelude string, snapshot records) plus the decoded
prelude: 3,751 KB held (3,137 KB heap plus 614 KB buffer). It counts the
envelope JSON plus the decoded prelude's length, 4,015 KB, so it holds 0.93x
what it counts; counting the envelope alone (3,401 KB) undercounted by 1.10x.
Storing sweeps entries past their window, so an isolate holds at most the
shells it read in the last window, capped by `memo.shellMaxBytes`.

**Defaults: 2 s and 16 MiB.** 2 s takes a key at 1 request/s per isolate
from 0% to 66% hits (5 s would make it 83%) while bounding the cross-isolate
staleness above at 2 s; 16 MiB holds five storefront-sized shells (about
17 MB of heap, an eighth of a 128 MB Workers isolate) and hundreds of small
ones. Raise the window for pages that are hot site-wide but lukewarm per
isolate; set it to 0 to turn the memo off.

**The tail waits a macrotask.** A memo hit hands the tail a snapshot that is
already in memory, so the tail's seed, match, and Flight render started in the
same microtask run as the commit, ahead of the runtime writing the prelude
(local workerd, 200 samples: 5.9 ms over the floor for `/ppr-large`, worse
than the store read's 3.6 ms). `serveShellHit` yields one macrotask before
the tail's work when the snapshot had already arrived; memo hits measure
1.3 ms. `MemorySegmentCacheStore` and build-time shells had the same in-memory
snapshot and get the same fix. A snapshot still arriving on I/O yields on its
own, so it gets no extra macrotask (Node clamps `setTimeout(0)` to 1 ms).

## The tag-marker memo

Once the shell memo takes the store read off a HIT, a tagged shell's first
byte is its tag-marker read: 10.5 ms of a 10.5 ms `CFCacheStore` memo hit, 7.0
ms of a 7.0 ms `VercelCacheStore` one, against 0.1 ms untagged. On a store
read, `CFCacheStore` could only start that read once the entry's head named
the tags. Decision 2 (revised) takes the marker read off the critical path for
plain reads and keeps reads after a mutation correct.
`src/cache/isolate-tag-memo.ts` holds the two pieces both stores share:

- **Tag-name hints** (`TagNameHints`): per isolate, the tag names each shell
  key carried when it was last read or written here, plus the route's
  `ppr.tags`, which the serve path passes as `tagHints` before the first
  read. A HIT starts those marker reads before the store match resolves
  (`CFCacheStore` through the per-request memo and in-flight map, so the
  check after the head reuses them; `VercelCacheStore` alongside the entry
  read). The check itself always uses the entry's own tags: a wrong hint
  costs a wasted read, and a tag missing from the hints is read when the head
  names it. Names only, never values; 2,048 keys, least recently used evicted.
- **The marker value memo** (`TagMarkerMemo`): a tag's latest invalidation
  time (or none), per isolate, stale-while-revalidate. A value younger than
  `memo.markerFreshMs` is used as is; one younger than `memo.markerMaxStaleMs`
  is used while one background read (per tag, kept alive with `waitUntil`)
  refreshes it; an older one waits for the store read. A value's age counts
  from the start of the read that returned it, not its end: a marker written
  while the read was in flight may be missing from it. Markers only move
  forward, so a read that started before an `invalidateTags()` cannot
  overwrite the value it wrote through. A timed-out read fails open for its
  request but is never memoized. 4,096 tags, least recently used evicted.
  Both stores go through one `TagMarkerMemo.readThrough(key, fetch, options)`.

Only PPR shell reads use the value memo. `cache()`, `"use cache"` and
response entries, and the shell write gate (`isTagsInvalidatedSince`, which
also serves build-time shells), keep reading their markers, so their
`updateTag()` semantics do not change.

That scope has to hold inside a request too, and it took two tries.
`CFCacheStore` keeps a per-request marker memo that every read of a tag in the
request shares. First the shell read wrote its memoized values into it, so a
request whose shell read MISSED (with `ppr.tags` hinted, that is the first
read of every key) rendered its foreground with them: a `"use cache"` item
invalidated in another isolate read as valid, and a new `cache()` segment
written after the invalidation stored it. Then a HIT copied its entry's own
tags across, meant for the tail. The document tail runs on a derived context
(`Object.create(reqCtx)`), whose per-request memo is its own, so that copy did
nothing there; but a partial navigation's replay gate reads the shell on the
same context its `matchPartial` renders on, which then read its data under the
stale value, and a `cache()` segment it wrote kept the stale item past
`markerMaxStaleMs` under a fresh `taggedAt`. Now the shell read keeps its
marker values in its own per-request record (`cf-tag-marker-memo.ts`
`getShellMarkerReads`) and nothing copies them anywhere: every data read in
the request, HIT or MISS, reads its markers exactly as before this memo, as
`VercelCacheStore`'s already did (it has no per-request marker memo, and its
data families do not read `tm` markers). A value the request already holds
(its own `invalidateTags()`, or a store read) still wins over the isolate
memo for the shell read.

A mutation gets correct reads at three levels:

| who                                | how                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the request that ran `updateTag()` | the per-request marker memo (unchanged)                                                                                                                                                    |
| later requests on the same isolate | `invalidateTags()` writes the new marker into the isolate memo, drops the isolate's memoized shells for the tags, and keeps in-flight reads from memoizing them (`RecentTagInvalidations`) |
| the same user on any isolate       | the fresh-reads cookie: requests carrying it skip the shell memo and the marker memo                                                                                                       |

The fresh-reads cookie is `<state cookie prefix>-fresh` (`browser/cookie-name.ts`
`freshReadsCookieName`; `rango-state-fresh` by default), set by `updateTag()`
and `revalidateTag()` through `RequestContext._setFreshReadsCookie`:
`HttpOnly` (the client never reads it), `SameSite=Lax`, `Path=/`, `Secure` on
https, one `Set-Cookie` per response. It is named by the state cookie's
prefix, not the router: routers on one host often share a store, and a
mutation through one of them should send the user past the memos the others
read too. A router with its own `stateCookiePrefix` gets its own cookie.

Its `Max-Age` is the longest any invalidated store's memos can be stale
(`SegmentCacheStore.freshReadsWindowMs`, rounded up to seconds): the shell
window, or with markers the marker max-stale cap, plus
`FRESH_READS_MARGIN_MS` (1 s). The margin is for `revalidateTag()`, whose
marker writes run in the background and can land after the response that
sets the cookie; with values aged from their read's start, the memos' windows
count from the write. A store with both memos off (`MemorySegmentCacheStore`,
or `{ shellMs: 0, markerFreshMs: 0 }`) reports none, and no cookie is set.

It never lands on a shared cached response: the document cache already
refuses any response that sets a cookie (`cache/document-cache.ts`
`shouldCacheResponse`), and the stores strip `Set-Cookie` from what they keep.
The flip side: a response whose request invalidated is not cached by the
document cache, a response route's `cache()`, or a CDN that skips responses
with cookies. A request carrying it reads the shell and its markers from the
store and refreshes the isolate's marker memo with what it read. Any client
can send the cookie; that only makes its own requests read the store, the
same cost as memos off, so it needs no rate limit. The opt-in `tagCacheTtl`
per-colo marker copy keeps its own documented ceiling.

One limit: headers leave with the response, so a call from a streaming loader
or render, after the handler handed the response to the host
(`RequestContext._responseSent`, set in `rsc/handler.ts`), cannot set the
cookie. The invalidation still runs; dev warns that the cookie was not set.
Server actions, route handlers and middleware run before the handoff.

What other users can still see, per store:

| store                     | markers                                            | other users, same location                          | other users, elsewhere                                                                                    |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `CFCacheStore` with KV    | KV, eventually consistent (~60 s)                  | up to `markerMaxStaleMs` (10 s) after the last read | KV's own propagation, plus up to `markerMaxStaleMs`                                                       |
| `CFCacheStore` without KV | none (purge mode evicts the entry)                 | the shell memo window (2 s) of an isolate's copy    | same                                                                                                      |
| `VercelCacheStore`        | regional `cache.set`, `expireTag` global (~300 ms) | up to `markerMaxStaleMs` (2 s) after the last read  | a region that memoized the shell serves it until its shell window passes (its markers never arrive there) |

Measured with the tagged `/ppr-large` entry (`CFCacheStore`: the #941 edge
latencies, workerd's native base64; `VercelCacheStore`: 6 ms per
runtime-cache `get`, a model, not measured on Vercel), first byte, median
[p25-p75] of 25 HITs:

| read                                           | before (shell memo only) | after, marker memo on | after, `{ markerFreshMs: 0 }` |
| ---------------------------------------------- | -----------------------: | --------------------: | ----------------------------: |
| `CFCacheStore` store read                      |      17.5 [16.8-17.8] ms |      8.3 [8.3-8.4] ms |              9.5 [9.4-9.7] ms |
| `CFCacheStore` shell memo hit                  |      10.5 [10.3-10.6] ms |      0.1 [0.1-0.2] ms |           10.5 [10.3-10.5] ms |
| `CFCacheStore` memo hit, stale marker          |                        — |      0.2 [0.2-0.3] ms |                             — |
| `CFCacheStore` with the fresh-reads cookie     |                        — |      9.6 [9.5-9.7] ms |              9.5 [8.9-9.5] ms |
| `VercelCacheStore` store read                  |      18.5 [18.1-19.2] ms |   10.9 [10.8-11.0] ms |           10.8 [10.5-10.9] ms |
| `VercelCacheStore` shell memo hit              |         7.0 [7.0-7.1] ms |      0.1 [0.1-0.2] ms |              7.0 [7.0-7.1] ms |
| `VercelCacheStore` memo hit, stale marker      |                        — |      0.2 [0.1-0.2] ms |                             — |
| `VercelCacheStore` with the fresh-reads cookie |                        — |   10.8 [10.4-10.9] ms |           10.7 [10.5-10.9] ms |

The store-read gains are the hints: the marker read overlaps the entry read
instead of following it (`VercelCacheStore`'s store read is the entry `get`
plus the loop decode of the prelude either way). The memo-hit gain is the
value memo. A stale value costs the same as a fresh one on the critical path,
so the fresh window mostly sets how often a background refresh runs (at most
one marker read per tag per isolate per window); the max-stale cap is the
staleness bound other users see.

**Defaults: `CFCacheStore` 1 s fresh, 10 s max-stale; `VercelCacheStore`
300 ms fresh, 2 s max-stale.** On Cloudflare, KV already takes up to about
60 s to propagate a marker across locations, so a 10 s cap stays inside the
platform's own staleness while one isolate refreshes a hot tag at most once a
second. On Vercel, `expireTag` removes entries everywhere in about 300 ms, so
the fresh window matches it and the cap stays at 2 s. The fresh-reads cookie
lasts the longer of the shell window and the cap, plus 1 s: 11 s with
`CFCacheStore` and KV, 3 s otherwise. `{ markerFreshMs: 0 }` restores a marker
read per HIT; `{ shellMs: 0, markerFreshMs: 0 }` makes every user's next
request see an invalidation (with KV, the shell memo off alone still leaves
the marker memo's window).

## Decisions

1. **Per-isolate shell memo** (the issue's experimental patch): keep the last
   fresh `readShellDocument` result per key for N ms and skip the store read.
   Gain: the L1 match + prelude read (≈ 6-8 ms at the issue's numbers) on
   memo hits. Cost: an isolate keeps serving a generation for up to N ms after
   a newer capture lands, and in KV-less purge mode after a purge (the
   per-request marker memo still covers the invalidating request). With KV
   the marker check still runs per request. **Decided and built** (#959) as a
   per-store option with a byte cap, on by default: 2 s and 16 MiB, from the
   measurements in "The shell memo".
2. **Per-isolate marker memo** (option B in §4). First declined in any form:
   the marker read runs in parallel with the prelude read (option A) and is
   awaited before the commit. **Revised:** plain reads get stale-while-
   revalidate, and reads after a mutation stay correct in the mutating
   request, on the same isolate, and for the same user on any isolate (the
   fresh-reads cookie). **Built** (#960, "The tag-marker memo") in one
   store-agnostic module for both stores, with the tag names a shell carries
   hinted per isolate. The value memo serves PPR shell reads only; cached data
   families and the shell write gate keep reading their markers. Defaults
   (1 s / 10 s on `CFCacheStore`, 300 ms / 2 s on `VercelCacheStore`) follow
   the measurements there.
3. **Pruning with live-lane loaders** (rule R2.3). Pruning when a route has
   live loaders changes "seeded everywhere" for keys the shell and a hole
   share: the hole shows live data. **Decided:** drop R2.3, holes are the live
   lane. **Built** (#958); the regression check run before it shipped added
   R2.5 (a route-derived `cache()` scope keeps every record) and residual B (a
   HIT whose doc record fails to decode re-runs handlers live and schedules a
   recapture).
4. **A public split read** (promote `readShellDocument` to the
   `SegmentCacheStore` contract so custom stores can serve the prelude
   first). **Decided:** no; it stays an `@internal` method only built-in
   stores implement (reason and the preferred future public shape under "The
   contract stays as it is").
