# Per-app cache versions: releasing without clearing the cache

Status: proposal, not built. Written 2026-10-03, after router 0.20.0.

Read [caching.md](./caching.md) first if you have not: this document only
changes how cache entries are versioned, not how they are produced or keyed.

## Why

Today every production build gets a new version, and every cache entry lives
under it. So every deploy starts with a cold cache, and under a host router a
deploy of one app clears the cache of every other app in the same build.

The mechanics, so you can check them:

- The version is the build time: `Date.now().toString(16)` in
  `createVersionPlugin` (`packages/rangojs-router/src/vite/plugins/version-plugin.ts`).
  One value per build, exported as `VERSION` from `@rangojs/router:version`.
- `CFCacheStore` defaults its `version` to that value and prefixes every key
  with `v/<version>/` (`src/cache/cf/cf-cache-store.ts`, `toKVKey` and the
  Cache API request builder).
- `createRSCHandler` defaults its `version` to the same value
  (`src/rsc/handler.ts`). That one value stamps PPR shell entries
  (`ShellCacheEntry.buildVersion`, `src/cache/types.ts`) and is what the
  browser sends back as `_rsc_v`; a mismatch forces a reload.

A rebuild of unchanged source is therefore a cache clear. Nothing about the
app changed; only the clock did.

## The rules a consumer should have to remember

1. Same server code, same cached data. Rebuilding or redeploying an app whose
   server code did not change keeps its cached data.
2. Each `createRouter()` app has its own cache version. Under a host router,
   deploying a change to one app does not clear the others.
3. Any change to an app's server code clears that app's cached data, all of
   it. We do not try to judge whether a change is compatible.
4. `version` still overrides everything, in both directions.

Rule 3 is deliberately blunt. An earlier draft fingerprinted each cache
boundary separately; it was dropped because nobody could predict from a diff
whether a given entry would survive.

These rules apply to a single app exactly as they do to a host router. A
single app is one router.

## What a cached entry actually depends on

You might expect a cached RSC payload to be tied to the JS bundles of the build
that produced it. It is not.

In a production Flight payload a client component is written as
`{ id, name, chunks: [] }`. The `id` is the first 12 hex characters of a
sha256 of the module's root-relative path (`createClientManifest` and the
`referenceKey` derivation in `@vitejs/plugin-rsc` 0.5.35). No chunk file name
is stored. When the payload is decoded, the running build maps the id to
whichever chunk holds that module now. So a payload cached before a release
re-links itself to the new build's components, and it does not matter how
`clientChunks` groups them. If the id is gone, decoding throws
`client reference not found '<id>'`.

That leads to the central point of this design. A cached payload is the output
of the app's server code. If the server code is unchanged, the cached payload
is what a fresh render would produce, apart from the data. Client component
internals do not enter into it: a change to styling or event handling inside a
client component leaves every cached payload exactly as valid as it was.
Adding, removing or renaming a client export does change the server build
(the reference proxies live there), and so does moving the file.

Stored HTML is different. A PPR shell prelude and a document-cache response
contain hashed asset URLs (`/assets/router-<hash>.js`, stylesheet links), so
they are only valid while those files are the ones being served.

| What is stored                                     | Valid as long as                                |
| -------------------------------------------------- | ----------------------------------------------- |
| Segment entries, `"use cache"` values, loader data | the app's server code is unchanged              |
| PPR shells, document-cache responses               | server code and client asset URLs are unchanged |

## Two versions per router

Each `createRouter()` gets two versions. Both are computed; the consumer sets
neither.

- **Data version.** A hash of the app's server (RSC environment) code. It keys
  segment entries, `"use cache"` values and loader data.
- **Document version.** The data version plus the client asset URLs. It keys
  PPR shells and document-cache responses, and it replaces the build stamp in
  the `_rsc_v` check.

The document version has to cover the asset URLs for a second reason besides
stored HTML. A browser tab that loaded before a deploy still holds the old
chunk URLs. If those files are gone and the tab is not told to reload, its
next lazy chunk import fails.

What each kind of deploy does:

| Deploy                                  | Cached data         | Stored HTML           | Open tabs               |
| --------------------------------------- | ------------------- | --------------------- | ----------------------- |
| Rebuild, no code change                 | kept                | kept                  | untouched               |
| Server code of app A changes            | cleared for A only  | cleared for A only    | A's tabs reload         |
| Client code of any app changes          | kept for every app  | cleared for every app | every app's tabs reload |
| Code shared by A and B changes (server) | cleared for A and B | cleared for A and B   | A's and B's tabs reload |

The third row is the price of the shared client build, and it is cheap:
the HTML is re-rendered from cached data, not from scratch.

## What we measured

A spike on `examples/cloudflare-multi-router` (four sub-apps: `admin`,
`app-a`, `app-b`, `site`; Cloudflare preset; `RANGO_ENCRYPTION_KEY` pinned).
Five builds, compared per app after removing the build stamp and the file
hashes from the output.

| Change                             | `admin` server code | Other apps' server code | Client asset URLs         |
| ---------------------------------- | ------------------- | ----------------------- | ------------------------- |
| None (plain rebuild)               | same                | same                    | same                      |
| Server-only text change in `admin` | changed             | same                    | same                      |
| Route added to `admin`             | changed             | same                    | same                      |
| Client component change in `admin` | same                | same                    | changed for all four apps |

What to take from it:

- Per-app server code is well isolated. Each app has its own server chunk and
  its own route-manifest chunk (`virtual:rsc-router/routes-manifest/<routerId>`).
  A change in `admin` touched only `admin`'s chunks.
- A plain rebuild is byte-identical once the build stamp is removed. With it,
  nine server files are renamed, because the stamp sits in a shared chunk and
  every importer's hash follows.
- Client asset URLs are shared. In the client-change build 7 of 10 client
  files got new URLs although one had new content: plugin-rsc's
  client-reference map lands in the shared `react` chunk and imports every
  app's chunk by hashed file name.

Limits of the spike: one example app, one preset, apps that share no
app-level modules, and a comparison done by post-processing the output.

## How it would be built

This is a sketch to make the cost visible, not a plan of record.

1. **Compute the data version at build time**, per router, in the RSC
   environment. Most of the work is already done by the bundler: it
   content-hashes every output chunk (the hash in `handler-DlEh2HgZ.js`), and
   a chunk's hash covers the chunks it imports (the spike's client-change
   build shows this: one changed chunk renamed its importers). At the end of
   the build a plugin sees the whole chunk graph. So rango only has to pick a
   router's chunks and combine their hashes. The router is already identified:
   the `expose-ids` transform injects `$$id` and `$$sourceFile` into each
   `createRouter()` call (`src/vite/plugins/expose-ids/router-transform.ts`).
   Three things to handle:
   - The route-manifest chunk is loaded through a shared module, so it is not
     among the chunks the router's own chunk imports. Add it explicitly.
   - An entry chunk has no hash in its file name (`rsc/index.js`). A small app
     whose router lives in the entry needs that chunk's code hashed directly.
   - Whatever varies without a code change must not sit in a hashed chunk.
     Today the build stamp does, in a chunk every app imports.
     Where: rango already has a `generateBundle` hook on the RSC environment
     (`src/vite/router-discovery.ts`) and a `closeBundle` hook that rewrites
     server chunks on disk (`postprocessBundle` in
     `src/vite/discovery/bundle-postprocess.ts`: handler eviction, the
     prerender manifest, an injection into the entry). The hash has to be taken
     after that rewrite or it does not describe the bytes that ship. plugin-rsc
     builds the RSC environment twice, a scan pass and the real pass; only the
     real pass counts.
2. **Hand it to the router after hashing.** The version cannot live inside the
   code it is derived from. Write it at the end of the build, as a placeholder
   that is replaced once the hashes are final or as a small generated module
   that maps `$$id` to its versions. Rewriting server output after bundling is
   not new: `postprocessBundle` does it today.
3. **Compute the document version at build time too**, so that nothing is
   hashed at startup or per request. Client asset names are first known in the
   client build, and plugin-rsc writes its assets manifest only after every
   environment is built. rango's `buildApp` post hook
   (`src/vite/router-discovery.ts`) runs after that, with everything on disk.
   The build-time shell capture runs in that same hook and stamps shells with
   `api.getBuildVersion` from the version plugin; it has to read the final
   version from shared build state instead, so compute the version first.
4. **Give the stores the router's versions.** The cache factory is called per
   request with `(env, ctx)` and knows nothing about the router
   (`src/rsc/handler.ts`). The request context already carries `_routerId`,
   and `CFCacheStore` already resolves request-dependent values lazily
   (`resolveBaseUrl`), so put the versions on the request context and read
   them the same way. Keys are built in two functions per store, and the
   family is visible in both:
   - `CFCacheStore`: `keyToRequest` and `toKVKey`. Segment keys and `fn:`
     items take the data version; `doc:` and `shell2:` keep the document
     version.
   - `VercelCacheStore`: `toStoreKey(key, family)`. Families `s` and `i` take
     the data version; `r` and `h` the document version. It has no default
     version today, so its keys are unversioned unless the consumer passes
     one.
   - `MemorySegmentCacheStore` has no version and needs nothing.
5. **`version` keeps its meaning.** A consumer who sets `version` on the
   router or the store gets exactly that value for both, as today.
6. **Make tag invalidations apply across versions.** See "Rollbacks" below.

Dev is not in scope. The dev version is bumped on RSC module edits and that
stays as it is.

### Cost

The hashing happens once, at build time. Measured on the real server output of
four apps (figures and method under "Measuring it"), hashing every server
output file costs 0.7 to 2.5 ms when the bundler already holds the code in
memory, and 2.0 to 4.7 ms when the written files are read back from disk
first. That is 0.03% to 0.18% of those apps' build times. Combining the
content hashes the bundler already put in the chunk file names costs about
0.002 ms.

At run time there is no cost. A version is a constant string in the build, and
cache keys already carry a version prefix (`v/<version>/`); only the value
changes. No request and no cold start computes a hash.

### The encryption key becomes a plugin option

Inline server actions encrypt their bound arguments with a key that is random
per build unless `RANGO_ENCRYPTION_KEY` is set
(`src/vite/encryption-key.ts`). The key is inlined into the server build, so:

- with a random key every build has different server code, and nothing above
  keeps any cache; and
- that is the correct outcome. A payload cached under the old key carries
  arguments the new build cannot decrypt.

So a stable key is the precondition for keeping the cache across deploys, and
it should not be a hidden environment variable. Add
`rango({ encryptionKey })`, documented as
`rango({ encryptionKey: process.env.RANGO_ENCRYPTION_KEY })` and never as a
literal, validated when the config is read. The environment variable stays as
the fallback. The key stays part of the hashed code: changing it clears the
cache.

## Phasing

1. **Data version only.** Segment entries, `"use cache"` values and loader
   data move to the per-router data version. The handler's `version` (shells,
   document cache, `_rsc_v`) stays on the build stamp. This already delivers
   rules 1 to 3 for cached data, for single apps and host routers, and it
   cannot strand a browser tab because the reload check is untouched.
2. **Document version.** Shells, document-cache responses and `_rsc_v` move
   from the build stamp to the document version. After this a server-only
   deploy of one app no longer re-renders the others' HTML or reloads their
   tabs.

## Rollbacks

A timestamp is never reused as a version. A content hash is: deploy A, deploy
B, roll back to A, and A's version is live again with whatever A wrote still
in the store.

That breaks tag invalidation as it is stored today. `CFCacheStore` writes a
tag's marker under the version: the KV key is `v/<version>/__tag__/<tag>`
(`tagMarkerKey` through `toKVKey`), the edge-cache marker request goes through
`keyToRequest`, and the in-isolate memo is keyed by namespace, version and
tag (`markerMemoKey`). An invalidation made while B is live writes nothing an
A reader looks at, so after the rollback A's entries are served until their
TTL although they were invalidated.

The fix is small because the staleness check does not care about versions. An
entry records when its tags were attached, and `isGloballyInvalidated` only
asks whether the marker's time is at or after that
(`marker >= taggedAt`). So:

- store the KV marker, the edge-cache marker and the memo entry without the
  version, keeping the namespace where it is used today;
- leave the comparison alone;
- do the same for `VercelCacheStore`'s `tm` family.

Old versioned markers are simply never read again. This ships with phase 1,
not after it.

Two things were not checked: `createCloudflareZonePurge`, and whether the
tags `VercelCacheStore` passes to `expireTag` are version-scoped. The
Cloudflare purge tokens (`rg:{ns}:e:{tag}`) carry no version, so a zone purge
already reaches entries of every version.

## Open questions

- **Cached partial responses stay document-versioned.** Confirmed: an RSC
  payload carries the handler version in its metadata (`rsc-rendering.ts`,
  `full-payload.ts`), and the document cache stores those bytes. Served under
  a different version they would trip the `_rsc_v` reload check. Segment
  entries and items carry no version in their body, only in their key, which
  is what lets them move to the data version.
- **`router/manifest.ts` imports `VERSION` directly** for its match-cache key,
  independent of `createRouter({ version })`. Decide which version it follows.
- **`VercelCacheStore` defaults.** Decide whether it adopts the per-router
  versions by default or stays unversioned unless told otherwise.
- **Formatting-only changes.** A comment or whitespace change to server code
  changes the hash. Hashing normalized code would keep the cache for those;
  it is a refinement, not a requirement.
- **Shared client chunks between apps.** In the spike every client group
  belonged to one app. This does not affect the data version, but check an
  app where two routers share a client component before phase 2.
- **Other presets.** Only Cloudflare was measured. Repeat the spike on node
  and vercel.
- **Build-machine paths in the server code.** The `expose-ids` transform
  injects `$$sourceFile` as an absolute path, so each router's server chunk
  contains the checkout directory of the machine that built it (seen in the
  spike output: one occurrence per router). Left as is, a pipeline that moves
  the checkout directory changes every app's hash with no source change. The
  value is read during route discovery and by the CLI, not when serving a
  request, so make it root-relative in production builds.
- **Other sources of build nondeterminism.** One plain rebuild in the same
  directory showed none besides the stamp. Repeat it in CI, on a different
  machine and path, before relying on it.

## What counts as a change

Nothing in the pipeline has to detect whether code changed. The version is
computed from the code during `vite build`: the same server code produces the
same version, the same version produces the same cache keys, and the new
deployment finds the entries the previous one wrote. There is no comparison
with the previous build and no state to carry between runs.

So the question is only what goes into the hashed code.

| A pipeline run changes                                                    | Server code | Cached data |
| ------------------------------------------------------------------------- | ----------- | ----------- |
| CI config, runner, deploy steps                                           | same        | kept        |
| Runtime environment: bindings, secrets read from `ctx.env`                | same        | kept        |
| Docs, tests, files no router imports                                      | same        | kept        |
| App server source                                                         | changed     | cleared     |
| A dependency version (lockfile), including React or rango                 | changed     | cleared     |
| A build-time value inlined into server code (`define`, `import.meta.env`) | changed     | cleared     |
| The encryption key                                                        | changed     | cleared     |
| The Vite or bundler version, if it emits different code                   | changed     | cleared     |

The cleared rows are the conservative side of rule 3: in each of them the
server could now render something different.

## Measuring it

The work this feature adds is build-time work, so the build is what gets a
baseline and a projection. Two smaller checks sit next to it: that the feature
keeps the cache at all, and that nothing moved at run time. All baselines are
from the 0.20.0 commit (`69c89c20`) on 2026-10-03, before any of this is
built.

### Build time: baseline and projection

Five `vite build` runs per app, wall-clock:

| App                                            | Build, median (min to max) | Per-environment `built in` (ms) |
| ---------------------------------------------- | -------------------------- | ------------------------------- |
| `tests/cloudflare-stress-demo` (26k routes)    | 2.65 s (2.50 to 2.90)      | 1270, 53, 379, 115, 97          |
| `examples/cloudflare-multi-router` (4 routers) | 1.74 s (1.73 to 2.15)      | 937, 75, 279, 135, 133          |
| `tests/cloudflare-basic`                       | 6.36 s (4.95 to 9.21)      | 2460, 90, 478, 158, 287         |
| `packages/rangojs-router/e2e/test-app` (node)  | 6.13 s (4.00 to 16.32)     | 2070, 94, 514, 217, 153         |

The per-environment column is Vite's own `built in` lines from the last run,
in the order plugin-rsc runs its five steps (scan rsc, scan ssr, rsc, client,
ssr). The rest of the wall time is startup, route discovery and rango's
post-build hooks.

Read the last two rows by their minimum. Those builds ran while other work
was loading the machine (load average 13 to 18, on battery), which is what
the 16 s outlier is. The first two rows ran at a load of about 6.

The projected cost of the hashing, measured on each app's actual server
output from those builds:

| App              | Server output      | Hash in memory | Read back from disk and hash | Share of median build |
| ---------------- | ------------------ | -------------- | ---------------------------- | --------------------- |
| stress-demo      | 111 files, 6.77 MB | 2.52 ms        | 4.65 ms                      | 0.175%                |
| multi-router     | 51 files, 1.97 MB  | 0.71 ms        | 2.02 ms                      | 0.116%                |
| cloudflare-basic | 130 files, 2.98 MB | 1.13 ms        | 2.77 ms                      | 0.044%                |
| test-app         | 86 files, 2.28 MB  | 0.82 ms        | 1.97 ms                      | 0.032%                |

- "Hash in memory" is one sha256 over every server output file, the case
  where the bundler hands the code to a plugin hook.
- "Read back from disk" is the case where the hash is taken after rango's
  post-bundle rewrite, from the files as written. It is the upper bound.
- The server output includes non-JS assets. In the stress demo 3.47 MB of the
  6.77 MB is the route manifest, emitted as a `.txt` asset; it has to be part
  of the hash, since route data is server behavior.
- The rate is about 0.37 ms per MB in memory and under 1 ms per MB from disk.
  A 50 MB server build would pay roughly 20 to 45 ms.

So the projection is under 5 ms and under 0.2% of the build for every app
measured. Run-to-run variance of the build itself is 10% or more (2.50 to
2.90 s on the quietest row), so this cost will not be visible in wall time;
what a before/after comparison can show is that nothing else got slower.

To compare after the feature, in one session on AC power with the machine
idle: five builds of each app on the base commit, five on the feature commit,
medians side by side. Pass means every median within the base run's min-to-max
range. Report the hashing step's own duration from a timer around it rather
than inferring it from wall time.

### Does it deliver: retention across a rebuild

The existing benchmark suite does not measure this, so it was measured by
hand on `tests/cloudflare-stress-demo`. `/app/cached/hot` sits inside a
`cache({ ttl: 300 })` boundary on a `CFCacheStore` with the default version,
and the page renders `Date.now()` inside the boundary, so the same number
back means a hit.

| Step                                         | Build version | Rendered-at     | Result |
| -------------------------------------------- | ------------- | --------------- | ------ |
| First request                                | `1a101ad4ae4` | `1791029499936` | stored |
| Second request, same server                  | `1a101ad4ae4` | `1791029499936` | hit    |
| Server restarted, same build                 | `1a101ad4ae4` | `1791029499936` | hit    |
| Rebuilt with no source change, first request | `1a101adbfc4` | `1791029529495` | miss   |

So today 0 of 1 entries survive a rebuild of unchanged code, and the only
thing that changed between the last two rows is the build stamp.

What the feature has to show, with the same steps:

| Change before the rebuild      | Today | Phase 1 |
| ------------------------------ | ----- | ------- |
| None                           | miss  | hit     |
| Client component only          | miss  | hit     |
| Server code of this app        | miss  | miss    |
| Server code of a different app | miss  | hit     |

This check is not timing-sensitive, so it can run in CI. Add it to the
harness with the feature (a `retention` phase in `bench/run.ts`, or an e2e
that rebuilds between two server starts) rather than leaving it a manual
script.

### Run time: a sanity check, not the claim

At run time the version is a string in a cache key, so no change is expected.
The stress demo's harness (`tests/cloudflare-stress-demo/bench/run.ts`, guide
in `BENCHMARK.md` next to it) was run once to have numbers to hold up against
a later run. Its `cached-hit` and `cached-miss-unique` scenarios go through
the store keys this feature changes.

`--runs 3 --duration 4 --cold-runs 3`, Apple M4:

| Metric                                     | Baseline                   |
| ------------------------------------------ | -------------------------- |
| Cold start, first request (`/bench/first`) | 32.6 ms (31.9 to 49.4)     |
| `cached-hit`                               | 148 req/s (IQR 116 to 218) |
| `cached-miss-unique`                       | 158 req/s (IQR 115 to 229) |
| `ssr-home`                                 | 210 req/s (IQR 117 to 273) |
| `rsc-nav-unique`                           | 184 req/s (IQR 138 to 295) |
| `/app/cached/hot` Server-Timing, no load   | 6.0 ms                     |

These are provisional: the run was on battery with the machine in use (load
average 2.3 at the start, 6.6 at the end), against a runbook that asks for AC
power and an idle machine. A first attempt with the default 5 runs of 5 s
failed in round 4 with `Scenario ssr-home: 9720 socket errors`; the cause was
not determined. The result file is
`bench/results/bench-2026-10-03-69c89c20.json`, local only because the
results directory is gitignored.

If a run-time claim is ever needed, it has to come from a same-session pair
compared with `bench/compare.ts`, quoting only the deltas it calls
significant.
