# Per-app cache versions: releasing without clearing the cache

Status: built, both phases. Written as a proposal on 2026-10-03 after router
0.20.0, then rewritten against the implementation; "Where the proposal was
wrong" lists what changed on the way.

Read [caching.md](./caching.md) first if you have not: this document only
covers how cache entries are versioned, not how they are produced or keyed.

## Why

Every cache key and every stored PPR shell carries a version. Until this
change that version was the build time: `Date.now().toString(16)` in
`createVersionPlugin` (`packages/rangojs-router/src/vite/plugins/version-plugin.ts`),
one value per build, exported as `VERSION` from `@rangojs/router:version`. So
every deploy started with a cold cache, and under a host router a deploy of
one app cleared the cache of every other app in the same build. A rebuild of
unchanged source was a cache clear: nothing about the app had changed, only
the clock.

Now a version is a hash of the code it versions. The same code builds to the
same version, the same version produces the same cache keys, and the new
deployment finds the entries the previous one wrote.

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
`referenceKey` derivation in `@vitejs/plugin-rsc` 0.5.35). No JS chunk file
name is stored. When the payload is decoded, the running build maps the id to
whichever chunk holds that module now. So a payload cached before a release
re-links itself to the new build's components, and it does not matter how
`clientChunks` groups them. If the id is gone, decoding throws
`client reference not found '<id>'`.

There is one exception, and it is a stylesheet. A SERVER component that
imports CSS is wrapped by plugin-rsc so that it renders
`<link rel="stylesheet" href="/assets/x-<hash>.css">` next to its output. That
hashed URL is in the Flight of every segment the component renders. It is
handled as part of the server code; see "Which code is a router's".

That leads to the central point of this design. A cached payload is the output
of the app's server code. If the server code is unchanged, the cached payload
is what a fresh render would produce, apart from the data. Client component
internals do not enter into it: a change to styling or event handling inside a
client component leaves every cached payload exactly as valid as it was.
Adding, removing or renaming a client export does change the server build
(the reference proxies live there), and so does moving the file.

Stored HTML is different. A PPR shell prelude and a document-cache response
contain hashed asset URLs (`/assets/router-<hash>.js`, stylesheet links), and
they were rendered by the SSR build, so they are only valid while those files
are the ones being served and that SSR code is the one running.

| What is stored                                     | Valid as long as                                             |
| -------------------------------------------------- | ------------------------------------------------------------ |
| Segment entries, `"use cache"` values, loader data | the app's server code is unchanged                           |
| PPR shells, document-cache responses               | server code, SSR output and client asset names are unchanged |

## Two versions per router

Each `createRouter()` gets two versions. Both are computed by `vite build`;
the consumer sets neither.

- **Data version.** A hash of the router's server (RSC environment) code. It
  keys segment entries, `"use cache"` values and loader data.
- **Document version.** The data version plus what stored HTML also depends
  on: the SSR output, the client asset names, the `base`, and the router's
  Prerender payloads. It keys PPR shells and document-cache responses, stamps
  `ShellCacheEntry.buildVersion`, and is the value the `_rsc_v` check compares.

The document version has to cover the asset names for a second reason besides
stored HTML. A browser tab that loaded before a deploy still holds the old
chunk URLs. If those files are gone and the tab is not told to reload, its
next lazy chunk import fails.

What each kind of deploy does (verified end to end on the node preset and on
Cloudflare, see "How it is tested"):

| Deploy                                  | Cached data         | Stored HTML           | Open tabs               |
| --------------------------------------- | ------------------- | --------------------- | ----------------------- |
| Rebuild, no code change                 | kept                | kept                  | untouched               |
| Server code of app A changes            | cleared for A only  | cleared for A only    | A's tabs reload         |
| Client code of any app changes          | kept for every app  | cleared for every app | every app's tabs reload |
| Code shared by A and B changes (server) | cleared for A and B | cleared for A and B   | A's and B's tabs reload |

The third row is the price of the shared client build, and it is cheap:
the HTML is re-rendered from cached data, not from scratch. It has one
exception: a stylesheet that a server component imports is server output, so a
change to it clears the cached data of the apps that render the component
("What counts as a change").

## What we measured before building

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

That spike was one example app, one preset, and a comparison done by
post-processing the output. Repeated on the node preset
(`packages/rangojs-router/e2e/test-app` and its `.host-fixture`) and on Vercel
(`examples/vercel-multi-router`) before writing any code, it did not hold, and
the reasons shaped the build. They are listed under "Where the proposal was
wrong".

## How it is built

### 1. Which code is a router's

The answer has to be "everything this router can run", and it is worked out on
the bundler's MODULE graph (`resolveRouterMembers` in
`packages/rangojs-router/src/vite/discovery/build-versions.ts`): follow static
and dynamic imports down from the router. That reaches lazily included route
groups (`include(prefix, () => import(...))`), intercepts and handler modules
without naming them.

Where the walk starts matters. It starts at the module that calls
`createRouter()` and at every module that statically imports it, directly or
through other static imports. The module that creates a router is not the only
one that decides what runs with it: the module a host mounts wraps
`router.fetch`, and an app module can attach middleware with `router.use()`.
Starting at the `createRouter()` module alone left that code in no version.
The climb stops at a dynamic import, because that is how a host mounts an app
it does not run with. Two consequences:

- a lazily mounted app (`.lazy(() => import("./apps/shop/handler.js"))`) is
  independent of the host entry and of its sibling apps;
- routers that one module imports statically share that module and everything
  it reaches. They still get separate versions, but a change to either moves
  both. Lazy mounts are what buys independence.

You might expect the chunk graph to be enough, since the bundler already
content-hashes chunks. It is not, because a build has registries: modules that
list every reference of the whole build and import each one.

- plugin-rsc's server-reference map (`virtual:vite-rsc/server-references`)
  imports every `"use server"` module, and plugin-rsc's own server runtime
  imports the map, so every router reaches it.
- rango's loader manifest (`virtual:rsc-router/loader-manifest`) imports every
  loader module, and the routes manifest (`virtual:rsc-router/routes-manifest`)
  imports every router's lazy route data.

A walk that followed them put every app's actions, and whatever those actions
import, in every router's set. So the walk stops at a registry. What a registry
points to belongs to a router only if the router reaches it another way:

- by its own imports (a server component importing an action), or
- through a client component it renders. A `"use client"` module is a leaf in
  the server graph (plugin-rsc replaces it with reference proxies), so an
  action or a fetchable loader that only client code imports is invisible
  there. It is visible in the CLIENT environment's module graph, where the
  same file imports it. The walk takes every module it reached that also
  exists in the client graph, walks the client graph from it, and adds the
  registry targets it finds. It repeats until nothing is added.

A registry target no router reaches belongs to every router: it can still be
called through any router's action or loader endpoint.

Five things a router's output depends on are in none of its chunks. Each is
added explicitly:

- **Its lazy route manifest** (`virtual:rsc-router/routes-manifest/<routerId>`),
  loaded through the registry by `ensureRouterManifest`.
- **Its `clientUrls()` projections.** A route group defined in a
  `"use client"` module reaches the server as a projection the build takes of
  that module: which loaders each route declares, `loading`, transitions, the
  route ids. The server materializes the group from it. The projection ships
  in the routes registry (the host entry's chunk), the client module is a
  reference proxy in the server graph, and the route trie holds none of it, so
  a route that switched loaders changed nothing a lazily mounted app hashed.
  Each projection is added, as `client-urls <module>`, for the routers that
  reach the module.
- **The encryption key.** plugin-rsc writes it to
  `__vite_rsc_encryption_key.js` next to the RSC entry and has chunks import
  that file at run time. It is added for a router with a module that encrypts,
  and only for those. "Encrypts" means the module calls
  `encryptActionBoundArgs(`, which plugin-rsc emits only for an inline action
  that closes over a value. Reaching the key module is not the test:
  plugin-rsc imports its encryption runtime into every `"use server"` module,
  so that would be nearly every router.
- **The stylesheets of its server components.** The wrapper plugin-rsc puts
  around a server component that imports CSS reads the URLs at run time from
  `__vite_rsc_assets_manifest.js` (`serverResources["<module>"]`), a file
  written after all bundles. A CSS-only change therefore left every server
  chunk identical while cached Flight kept linking the old file. Each entry is
  added, as `server-css <module>`, for the routers that reach the module
  plugin-rsc generates to render its links
  (`virtual:vite-rsc/css?type=rsc&id=<module>`).
- **Dependencies the bundle leaves external.** The Cloudflare and Vercel
  presets bundle everything. The node preset bundles only what needs the React
  server condition; any other dependency stays `from "pkg"` in the chunk,
  whichever version is installed. For each package a router's chunks import
  that way, the `name@version` of the package and of everything it depends on,
  as installed at build time, is added as `external <pkg>`
  (`src/vite/discovery/installed-packages.ts`). A registry package's code is
  fixed by its version. A linked workspace package is not; Vite bundles those
  unless the config lists one in `resolve.external`, and then its files are
  digested: every file in its directory but `node_modules` and `.git`,
  symlinks followed, so a build artifact in there that differs from build to
  build (a log, a `.tsbuildinfo`) moves the version, and a file that cannot be
  read fails the build. A package the build cannot find at all (no `node_modules`, a
  runtime-provided module) is described by a value unique to the build: the
  routers importing it get a new version every time, and the build names the
  packages.

The host entry is not part of a lazily mounted app. Nothing the app runs
imports it; it is to the app what the platform is. The consequence is in "What
counts as a change".

### 2. What is hashed

The bytes on disk of every chunk holding one of those modules
(`computeRouterVersions`), read in the `buildApp` post hook, after
`postprocessBundle` (`src/vite/discovery/bundle-postprocess.ts`) evicted
Prerender and Static handler code. A chunk is hashed whole, so a router's
version also covers whatever the bundler placed next to its code. That is the
conservative direction.

Four things are done to the bytes first, each for one measured reason:

- **Chunk file names are replaced.** A chunk's file name carries its content
  hash, and every chunk that imports it has the name in its bytes. So one
  router's change renamed its chunk and moved the hash of every chunk naming
  it, including shared ones. Each reference becomes the target's identity
  (its un-hashed name plus a digest of the module ids inside it) when the
  router owns the target, and one fixed token when it does not.
- **The server-reference map's body is skipped** (`stripServerReferenceMap`).
  It lists every action export of the build and sits in a chunk every router
  runs. Hashed as is, adding an action to one app changed every app's version.
  Each module it names is hashed by the routers that reach it, so nothing is
  lost. This works on the bundler's region comments; a minified server build
  has none and keeps the map in the hash, which clears more, never less.
- **Bundle assets are hashed as bytes**, not scanned: a large route manifest
  is staged as a `.txt` text module on Cloudflare (3.47 MB in the stress demo).
- **Virtual-module region comments are made root-relative**
  (`portableRegions`). The bundler prints a file module's region comment as a
  relative path, but a virtual id verbatim, and plugin-rsc's server CSS module
  has its importer's absolute path in the id
  (`virtual:vite-rsc/css?type=rsc&id=<encoded path>`). Left as is, the same
  source in two checkout directories built to two versions. The relative
  paths the bundler prints are relative to the directory the build runs from,
  not to the Vite root: `vite build` run from the app directory and
  `vite build apps/web` run from the repository root print different comments
  and give different versions. Build your deploys the same way each time.

Build-rendered payloads are not in any chunk the router keeps (the handler is
evicted, the payload ships as an asset module), so they are counted by digest,
recorded when they are rendered (`recordBuildData` in
`src/vite/discovery/prerender-collection.ts`):

- a **Static** payload is a segment of an ordinary route, so a `cache()` entry
  of that route stores it. It is part of the data version of every router that
  can run its handler.
- a **Prerender** payload is served from the build's own store and is never
  written to the segment cache (`withCacheLookup` returns before the cache
  scope). Only stored HTML holds it. It is part of its router's document
  version only.

A version is the first 16 hex characters of a sha256 over the sorted list of
those inputs, each a name and a digest. A chunk whose bytes name no other file
is digested once; one that does is digested once per distinct ownership of the
files it names, so routers that own the same ones share the work.

### 3. Handing the versions to the code they were computed from

A version cannot be a constant in the code it is a hash of. The
`@rangojs/router:version` module therefore ships a placeholder in a build
(`getVirtualBuildVersionContent` in `src/vite/plugins/virtual-entries.ts`):

```js
export const ROUTER_VERSIONS = __RANGO_ROUTER_VERSIONS__;
export const VERSION = ROUTER_VERSIONS["*"][1];
```

The module is byte-identical in every build, so it does not move the hashes.
After hashing, `runRouterVersionsPhase`
(`src/vite/discovery/router-versions-phase.ts`) replaces the token in the
written chunk with the table: router id to `[data, document]`, plus `"*"`, the
whole-build pair, for a router the build could not attribute. `VERSION` is the
whole-build document version. The token is replaced in every environment's
output that holds the module, not only the RSC one: a second worker that
imports a cache store bundles it too.

There is one way to get versions and no stand-in for it:

- If the versions cannot be computed (the RSC bundle was not recorded, a file
  exists and cannot be read), the build fails. A fallback stamp would quietly
  bring back "every deploy clears the cache", and nobody reads a warning in a
  build log.
- An unreplaced token is a free identifier, so the module throws a
  `ReferenceError` when it evaluates. A build that skipped the step cannot
  serve with a version that never changes.

A router the build cannot attribute (its module is not in the server bundle)
is not an error: it serves with the whole-build pair, which any change moves,
and the build log marks its line `(whole build)`.

The same hook then runs the build-time PPR shell capture
(`runShellPrerenderPhase`), which stamps each shell with the document version
of the router that owns it, from the table just computed.

Every build prints the versions, and leaves what each one was computed from in
`node_modules/.rangojs-router-build/cache-versions.json`. A version is one
hash, so a changed version says nothing about what changed; diffing two
builds' files names the chunk, payload or key that did.

```
[rango] Cache versions for 2 router(s), data / document (13.5ms):
[rango]   089295a905c2ac9c / 04f098c068051ed1  src/apps/a/router.tsx
[rango]   83115bcfbb9b35c1 / fc93d46fcd5ab63e  src/apps/b/router.tsx
```

### 4. At run time

`resolveRouterVersions(routerId, override)`
(`src/server/build-version-table.ts`) answers in this order: a consumer-set
`version`, the router's entry in the build table, the whole-build entry, and in
dev the stamp. There is no hashing at run time; a version is a string in a
table.

`createRSCHandler` resolves its router's pair once. The handler's own
`version` is the document version: everything the handler versions is tied to
the HTML a tab holds. The data version is only a cache-key prefix, so it
travels to the stores on the request context (`_versions`), read per operation
by `getCacheVersions()` the same way `CFCacheStore` already resolved its base
URL. The cache factory builds a store per request without knowing the router.

Every consumer of a version, and which one it uses:

| Consumer                                                                                                                                                                       | Version                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Payload `metadata.version`: document, partial, PE, action, 404 (`src/rsc/full-payload.ts`, `rsc-rendering.ts`, `progressive-enhancement.ts`, `server-action.ts`, `handler.ts`) | document                                  |
| `_rsc_v` reload check (`classifyRequest`, `src/router/request-classification.ts`)                                                                                              | document                                  |
| PPR shell stamp and gate (`buildVersion`, `isValidShellHit`, partial replay)                                                                                                   | document                                  |
| Build-shell read-through (`lookupBuildShell`) and its verdict memo                                                                                                             | document, per asking router               |
| Rango state value `{version}:{timestamp}` (`_rotateStateCookie`, `browser/rango-state.ts`)                                                                                     | document                                  |
| Browser: app version, `_rsc_v` on navigation, prefetch and action requests                                                                                                     | document, learned from `metadata.version` |
| Browser: location-state stamp on a history entry (`__rsc_lsv`, `setLocationStateVersion`)                                                                                      | document, as the document loaded with     |
| `CFCacheStore` segment entries and `fn:` items                                                                                                                                 | data                                      |
| `CFCacheStore` `doc:` responses and `shell2:` shells, and the shell memo key                                                                                                   | document                                  |
| `VercelCacheStore` families `s`, `i`                                                                                                                                           | data                                      |
| `VercelCacheStore` families `r`, `h`                                                                                                                                           | document                                  |
| Tag markers: `CFCacheStore` KV `__tag__/`, L1 `__tagmarker__/`, isolate memo; Vercel `tm`                                                                                      | none                                      |
| `MemorySegmentCacheStore`                                                                                                                                                      | none (the process is the scope)           |
| Prerender and Static stores                                                                                                                                                    | none (they ship with the build)           |
| `src/router/manifest.ts` match memo                                                                                                                                            | `VERSION`, as the dev module generation   |

Cached RSC partial responses stay on the document version: their bytes carry
`metadata.version`, and the document cache stores those bytes.

Under a host router the reload check has a neighbour. A tab of app A that
navigates to app B sends A's version to B's handler, and every router now has
its own, so that comparison would always fail. `classifyRequest` therefore
checks for an app switch (another router's id on a partial request) before it
compares versions: the answer is the same full document load, reported as what
it is.

Location state follows from the same value. A history entry's state is read
only under the app version that wrote it, and the browser's app version is the
document version. So a tab keeps its location state across a rebuild or a
redeploy of unchanged code, and drops it after a deploy that changes the app's
server code or the client assets, which is when its shape can have changed.

Dev is unchanged. Both versions are one stamp, bumped on every RSC module
edit.

### The stores

Keys are built in two functions per store, and each call site names its
family:

- `CFCacheStore`: `keyToRequest(key, family)` and `toKVKey(key, family)`, with
  `versionPath(family)` supplying `v/{version}/`.
- `VercelCacheStore`: `toStoreKey(key, family)`.

A store-level `version` is used for every versioned family, as before.

`VercelCacheStore` adopts the per-router versions by default, like
`CFCacheStore`. It had no default version, so its keys were unversioned unless
the consumer passed one, and the documented wiring put the deployment id in the
`getCache({ namespace })` handle, which clears the cache on every deploy.
"Same code, same cache" should not depend on which store you use, and an
unversioned persistent store serves an old build's entries to changed code.
A deployment-scoped namespace still works and still clears on every deploy.

`MemorySegmentCacheStore` has no version and needs none. A custom persistent
store reads the pair the built-in stores use with `getCacheVersions()` from
`@rangojs/router/cache`, per operation and inside
the request.

One consequence to plan for. A version used to be unique to a build, so two
deployments pointed at one store never met. Now two deployments of the same
code (a preview and production built from one commit, two regions, a canary)
have the same versions and read each other's entries. For segment entries that
is usually what you want, and their keys carry the host anyway. A
`"use cache"` item key carries no host, so if a preview reads a different
backend than production, it must not share production's store: give each
environment its own KV namespace or `namespace`, or its own `version`.

### The encryption key is a plugin option

Inline server actions encrypt their bound arguments with a key that is
generated per build unless one is supplied. A payload cached under one key
carries arguments another key cannot decrypt, so the key is part of the
version of every router whose code encrypts with it. With a generated key
those routers get a new version on every build, which is correct and also
means their cache is cleared on every deploy.

A stable key is therefore the precondition for keeping their cache, and it
should not be a hidden environment variable:

```ts
rango({ encryptionKey: process.env.RANGO_ENCRYPTION_KEY });
```

Never a literal. The value is validated when `rango()` is called
(`configureEncryptionKey` in `src/vite/encryption-key.ts`): base64 that
decodes to an AES key size. `undefined` falls back to the
`RANGO_ENCRYPTION_KEY` environment variable, then to a generated key.

A router with no inline action that closes over a value encrypts nothing, and
keeps its cache with or without a stable key; file-level `"use server"`
actions do not count. So the build says something only when it applies: once,
when a router's version depends on a key generated for that build.

```
[rango] No stable encryption key: 1 router(s) encrypt server-action arguments with a key generated for this build, ...
```

## Rollbacks

A timestamp is never reused as a version. A content hash is: deploy A, deploy
B, roll back to A, and A's version is live again with whatever A wrote still
in the store.

That broke tag invalidation as it was stored. `CFCacheStore` wrote a tag's
marker under the version: the KV key was `v/<version>/__tag__/<tag>`, the
edge-cache marker request went through the versioned key builder, and the
in-isolate memo was keyed by namespace, version and tag. An invalidation made
while B was live wrote nothing an A reader looked at, so after the rollback
A's entries were served until their TTL although they were invalidated.

Markers are now stored without the version, in all three places and in
`VercelCacheStore`'s `tm` family; the namespace stays where it was used. The
comparison is untouched: an entry records when its tags were attached, and
`isGloballyInvalidated` only asks whether the marker's time is at or after
that. Old versioned markers are never read again.

The two paths the proposal had not checked are version-free already:

- `createCloudflareZonePurge` purges the tokens it is handed, which are
  `rg:{ns}:e:{tag}` and `rg:{ns}:lk:{tag}`: namespace and tag, no version. A
  zone purge reaches the entries of every version.
- `VercelCacheStore` passes `expireTag` the tags as the consumer wrote them.

## What counts as a change

Nothing in the pipeline has to detect whether code changed. The version is
computed from the built output: the same output produces the same version, and
there is no comparison with the previous build and no state to carry between
runs. So the question is only what goes into the hashed bytes.

| A pipeline run changes                                                       | Cached data | Stored HTML |
| ---------------------------------------------------------------------------- | ----------- | ----------- |
| CI config, runner, deploy steps, the checkout directory                      | kept        | kept        |
| Runtime environment: bindings, secrets read from `ctx.env`                   | kept        | kept        |
| Docs, tests, files no router imports                                         | kept        | kept        |
| The host entry (the file creating the host router), for a lazily mounted app | kept        | kept        |
| App server source, including an action only a client component imports       | cleared     | cleared     |
| A dependency version (lockfile), bundled or left external                    | cleared     | cleared     |
| A build-time value inlined into server code (`define`, `import.meta.env`)    | cleared     | cleared     |
| The encryption key, for a router that encrypts with it                       | cleared     | cleared     |
| A Static payload (the handler, or the data it read at build time)            | cleared     | cleared     |
| A stylesheet a server component imports                                      | cleared     | cleared     |
| What a `clientUrls()` module declares for the server (loaders, loading, …)   | cleared     | cleared     |
| A Prerender payload (the handler, or the data it read at build time)         | kept        | cleared     |
| Client component internals, a stylesheet they import, any client asset       | kept        | cleared     |
| The Vite or bundler version, if it emits different code                      | cleared     | cleared     |

"Cleared" is per router: for the routers whose code the change is part of.
Five rows deserve a second look.

**The host entry.** A change to host-level code (host middleware, a new mount)
does not change a lazily mounted app's version. If the host changes what an
app receives, and the app renders from it inside a cache boundary, bump the
app's `version` or invalidate its tags. An app the entry imports statically
does cover the entry, and so does an app whose router the entry creates.

**Stylesheets.** A stylesheet that server code links is part of that app's
data version, because its hashed URL is in what the server renders. That is
both forms: `import "./x.css"` in a server component (the URL comes from the
assets manifest, added as `server-css`) and `import href from "./x.css?url"`
in a server module (the URL is a literal in the chunk). It changes whenever
the compiled CSS does. With a framework that compiles one stylesheet from
every class in the app, that is any class change anywhere, in a client
component too: for such an app "a client change keeps cached data" holds for
changes that leave the compiled CSS alone. A stylesheet imported by a client
component is linked from the client reference at render time and is in no
cached payload.

**Dependencies left external.** What is hashed for one is `name@version` of
the package and of its dependencies, as installed when the build ran. A
package whose files change while its version stays (a patched package, a git
dependency reinstalled from a moved ref) is not seen. Change `version` when
you deploy one. And what is installed can differ by machine: a package with
platform-specific optional dependencies (a native binding per OS and CPU)
describes differently on macOS and on Linux, so a router that leaves such a
package external gets one version per build platform. Build your deploys on
one.

**Build-rendered payloads.** A payload that differs between two builds of the
same source moves its router's version on every build. Two things do that: a
handler that renders something only true at build time (`Date.now()`, a random
id), and an inline action with bound arguments inside a Prerender or Static
handler, because plugin-rsc encrypts with a random IV. Both
`packages/rangojs-router/e2e/test-app` and `tests/cloudflare-basic` do the
first on purpose, so their main router gets a new version on every build;
`cache-versions.json` shows it as `prerender ...` and `static ...` lines.

**The bundler.** The version is a hash of what the bundler wrote, so it is as
stable as the bundler's output. Two places where plugin-rsc's output differed
between builds of one source are fixed at the source (`stableRscOutput`). If a
plugin of yours writes something that varies (a timestamp, a random id, the
build directory) into server code, the versions follow it; diff two builds'
`cache-versions.json` to find the file.

## Where the proposal was wrong

The proposal was written from code reading and one spike. These are the places
the implementation contradicted it.

- **"rango only has to pick a router's chunks and combine their hashes."** Not
  workable, for the reasons in "Which code is a router's" and "What is
  hashed": chunk file names carry content hashes into every importer, and the
  registries pull every app into every closure. Membership is per module and
  the bytes are normalized instead.
- **Per-app server code is isolated.** True on Cloudflare only.
  `@cloudflare/vite-plugin` builds its entry with
  `preserveEntrySignatures: "strict"`; Vite's default for a server build is
  `"allow-extension"`, which lets the bundler park shared modules in the entry
  chunk. On the node and Vercel presets the entry of a host app held 80
  modules of router runtime plus every sub-app's generated route names, and
  every sub-app chunk imported it back; the entry also names each sub-app's
  chunk by its hash. No router's version was independent. The node and Vercel
  RSC builds now use `"strict"` too (`RSC_ENTRY_SIGNATURES` in
  `src/vite/rango.ts`), and the entry of the same host app holds 9 modules.
- **"A plain rebuild is byte-identical once the build stamp is removed."** Not
  on `e2e/test-app`: 2 of 2 consecutive builds differed. plugin-rsc writes its
  server-reference map in the order its transforms first saw each server
  action module (`manager.stabilize()` sorts the client-reference map, not
  this one). rango's own loader manifest was in directory-scan order and the
  client-URL projections in transform order. All three are sorted now
  (`stableRscOutput`, `exposeInternalIds`, `generateRoutesManifestModule`).
  A fourth showed up only with a stylesheet in a server component, and only
  sometimes (1 of 10 concurrent builds of the test fixture): plugin-rsc's
  modules import the assets manifest under three local names, the bundler
  merges them into one import per chunk, and which name it kept varied.
  `stableRscOutput` renames them to one.
- **"The key is inlined into the server build."** In a build plugin-rsc 0.5.35
  writes it to its own file and imports it at run time, so a different key
  left every chunk identical. The file is added to the hash explicitly.
- **Which routers depend on the key.** The first implementation asked whether
  a router reaches plugin-rsc's key module. plugin-rsc imports its encryption
  runtime into every server action module, so nearly every router did, and a
  build without a stable key would have cleared nearly every cache. The test
  is now whether a module of the router calls the encrypt function.
- **"No chunk file name is stored in a payload."** True for JS. A server
  component's stylesheet URL is stored, and it comes from a manifest read at
  run time, so no server chunk changes when the CSS does.
- **"A router's code is what its `createRouter()` module imports."** It is
  also what the modules importing the router run, and what a `clientUrls()`
  module tells the server to run, which is in a registry and not in the app.
- **"The presets bundle server dependencies."** Cloudflare and Vercel do. The
  node preset leaves most dependencies external, so a lockfile bump changed
  nothing that was hashed.
- **The document version is the data version plus the client asset URLs.** It
  also needs the SSR output (it renders the HTML, and `import.meta.env.SSR`
  code can change without a client asset changing), the `base`, and the
  Prerender payloads.
- **Router ids.** Not in the proposal at all. `$$id` was a hash of the file
  path and the LINE of the `createRouter()` call in the code the transform
  hook receives, which has already been through the TypeScript transform. A
  dev server keeps comments there and a build drops them, so build-time route
  discovery and the bundle disagreed on a router's id whenever a comment sat
  above the call: the build registered the router's lazy route manifest (and
  would have registered its versions) under an id no running router had.
  Measured before the fix: `e2e/test-app`, `tests/cloudflare-basic`, and one
  of the four routers of `examples/cloudflare-multi-router`, which fell back
  to building their trie at run time. The line now comes from the file on
  disk (`routerCallLines` in `src/vite/plugins/expose-ids/router-transform.ts`).
  Router ids change once with this release for routers written that way.
- **`$$sourceFile`** is root-relative in a build, as proposed. It stays
  absolute on a dev server, where discovery and the CLI read it.
- **The build-shell verdict memo** (`validatedManifestRecord` in
  `src/rsc/shell-build-manifest.ts`) was keyed by the record alone, on the
  argument that the build version is constant in a process. It is per router
  now, and the manifest key is the pathname alone, so the memo is keyed by the
  asking router's version too.
- **`createRouter({ version })` on the node preset.** The generated entry
  passed `version: VERSION` to `createRSCHandler`, which overrode the router's
  own option. The handler now reads `options.version ?? router.version`, and
  neither the generated entry nor the Cloudflare entry injector passes one.
- **Cost.** The projection was under 5 ms. The measured step is larger; see
  "Measuring it".
- **Phasing.** The proposal split data version and document version into two
  releases. They ship together: with markers unversioned and the reload check
  on the document version there was no state in which phase 1 alone was safer.

## Open questions

- **Formatting-only changes.** A comment or whitespace change to server code
  changes the hash whenever it changes the emitted chunk. Hashing normalized
  code would keep the cache for those; it is a refinement, not a requirement.
- **Minified server builds.** The server-reference map can only be skipped in
  an unminified chunk, the default. With `build.minify` on the RSC
  environment, adding or renaming a server action in one app changes every
  app's data version.
- **Encrypted bound arguments in build-rendered payloads.** The random IV
  makes such a payload differ on every build. A deterministic IV for
  build-time encryption would have to come from plugin-rsc.
- **The host entry.** It could be given to every mounted app, with its
  references normalized. It was left out because it also holds the registries,
  which name every app.
- **Shared client chunks.** Client assets are one set for the whole build, so
  a client change in one app replaces every app's stored HTML. Per-app client
  asset sets would need the client-reference map out of the shared chunk.
- **Store operations outside a request.** A store builds its key from the
  request context, as `CFCacheStore` already did for the host. An operation
  that has lost the context keys with the whole-build pair: it misses, it
  never reads another version's entry. Whether a `waitUntil` continuation on
  deployed workerd can lose it for a cache write is not something a local run
  can show.
- **Linked packages left external.** Their whole directory is digested, build
  artifacts included, because nothing says which files an import can reach.
  Reading `files` and `exports` from the package's manifest would narrow it;
  until then a linked external with a log or a `.tsbuildinfo` in its
  directory gets a new version whenever that file changes. The build's
  `cache-versions.json` shows it as a changed `external <pkg>` input.
- **Installs without `node_modules`.** Yarn Plug'n'Play has no `node_modules`
  to look in, so on the node preset every external dependency would be "not
  found" and its routers would get a new version on every build (the build
  says so). Not tested. Resolving through the package manager's API would fix
  it.
- **One build, two keys.** The encryption key is resolved once per process. A
  process that loads two Vite configs with different `encryptionKey` values
  before building either is not supported.

## How it is tested

- `src/vite/__tests__/build-versions.test.ts`: membership and hashing on
  hand-built graphs.
- `src/vite/__tests__/cache-versions-build.test.ts`: fifteen real
  `vite build` runs of a two-app host fixture on the node preset, one per kind
  of change: server text, a route, a client component, a shared module, the
  key, an action only a client component imports, a new action, the host
  entry, code only the mounted handler reaches, a `clientUrls()` route that
  declares another loader, a server component's stylesheet, an external
  dependency and one of its dependencies, and the same source in a second
  directory.
- `src/vite/discovery/__tests__/installed-packages.test.ts` and
  `router-versions-phase.test.ts`: the phase against files on disk.
- `src/cache/cf/__tests__/cf-cache-store-versions.test.ts` and
  `src/cache/vercel/__tests__/vercel-cache-store-versions.test.ts`: key per
  family, and the rollback case.
- `src/testing/__tests__/build-versions.rsc-test.tsx`: through the public
  primitives, with `setBuildVersions` standing in for a build.
- `packages/rangojs-router/e2e/cache-version.test.ts` and
  `tests/cloudflare-basic/e2e/cache-version.test.ts`: a host fixture built
  four times with a server restart on each build, on a persistent store, with
  open tabs. The Cloudflare one builds its route manifests as Text modules,
  the form a large app deploys.

## Measuring it

Three questions, in the order they matter: does a cache entry survive a
deploy that did not change its app, what does the build pay for it, and did
anything move at run time. "Before" is the commit this work sits on; the
retention baseline is from router 0.20.0 (`69c89c20`). Retention, the
determinism samples, build time and the bundle guards were measured on
2026-10-04; the retention baseline and the run-time numbers on 2026-10-03,
before the second review's fixes, none of which touched the key-building path.
One machine: Apple M4, 10 cores, macOS 26.6, Node 24.12, Vite 8.0.16, rolldown
1.0.3, `@vitejs/plugin-rsc` 0.5.35.

### Retention

`tests/cloudflare-stress-demo`: `/app/cached/hot` sits inside
`cache({ ttl: 300 })` on a `CFCacheStore` with no `version`, and renders
`Date.now()` inside the boundary, so the same number back means the store
served the entry. `wrangler dev` keeps the Cache API and KV on disk between
server starts.

Before (measured by hand, the version was the build time):

| Step                                         | Build version | Rendered-at     | Result |
| -------------------------------------------- | ------------- | --------------- | ------ |
| First request                                | `1a101ad4ae4` | `1791029499936` | stored |
| Second request, same server                  | `1a101ad4ae4` | `1791029499936` | hit    |
| Server restarted, same build                 | `1a101ad4ae4` | `1791029499936` | hit    |
| Rebuilt with no source change, first request | `1a101adbfc4` | `1791029529495` | miss   |

After (`pnpm --filter cloudflare-stress-demo bench:retention`, which fails
when a row does not match its expectation):

| Step                                              | Versions (data / document)            | Rendered-at     | Result |
| ------------------------------------------------- | ------------------------------------- | --------------- | ------ |
| First request                                     | `55f401d8c3ea1e69 / 8fe8fdcefdea82ef` | `1791066825848` | stored |
| Second request, same server                       | `55f401d8c3ea1e69 / 8fe8fdcefdea82ef` | `1791066825848` | hit    |
| Server restarted, same build                      | `55f401d8c3ea1e69 / 8fe8fdcefdea82ef` | `1791066825848` | hit    |
| Rebuilt with no source change, first request      | `55f401d8c3ea1e69 / 8fe8fdcefdea82ef` | `1791066825848` | hit    |
| Rebuilt after a server-code change, first request | `4b76203e5f92d8f2 / abf3b482d9f9f55d` | `1791066833568` | miss   |

The stress demo is one router. Isolation between apps, the client-only
deploy, stored HTML and open tabs are covered by the cache-version e2e
suites: one scenario (`runCacheVersionScenario` in `tests/shared-e2e`) on a
two-app host fixture, built four times with a server restart on each build,
run on the node preset (`VercelCacheStore` over a file-backed handle) and on
Cloudflare (`CFCacheStore` with KV). "Kept" is the same `Date.now()` stamp
from a `cache()` route, or `x-rango-shell: HIT` with the same prelude stamp
from a `ppr` route; "stays" is a client-side navigation in a tab opened before
the deploy that does not reload the document.

| Deploy                         | App A: data / stored HTML / tab | App B: data / stored HTML / tab |
| ------------------------------ | ------------------------------- | ------------------------------- |
| Server restart, same build     | kept / kept                     | kept / kept                     |
| Rebuild, nothing changed       | kept / kept / stays             | kept / kept / stays             |
| App A's server code changed    | cleared / cleared / reloads     | kept / kept / stays             |
| A shared client module changed | kept / cleared / reloads        | kept / cleared / reloads        |

Both presets give this table. The Vercel preset has no deployed e2e; it is
covered at build level (below) and through `VercelCacheStore`'s unit tests.

### Same source, same versions

A version is only as stable as the build output, so this was sampled rather
than assumed.

| Build                                                                        | Runs | Distinct version tables |
| ---------------------------------------------------------------------------- | ---- | ----------------------- |
| `examples/cloudflare-multi-router` (4 routers), sequential                   | 10   | 1                       |
| `examples/vercel-multi-router` (2 routers), sequential                       | 10   | 1                       |
| `tests/cloudflare-stress-demo`, sequential                                   | 6    | 1                       |
| Test fixture (node preset, 2 routers), concurrent, each in its own directory | 44   | 1                       |
| The same fixture before `stableRscOutput` renamed the manifest import        | 10   | 2                       |
| The stress demo while its Text-module import counted as an unknown package   | 6    | 6                       |

The last two rows are scar tissue. One fixture build in ten came out with a
different local name for one import, which is why the rename exists. And the
stress demo is the only app in the first three rows whose route manifest is
large enough to ship as a workerd Text module: @cloudflare/vite-plugin imports
it through a marker specifier that looked like a package nobody had installed,
and a package the build cannot find gets a per-build value on purpose
(`externalPackage` in `src/vite/discovery/build-versions.ts` now rejects a
name npm would). No unit test or e2e saw it; this sample did. The Cloudflare
cache-version e2e now builds with `RANGO_MANIFEST_TEXT=1` so CI does.

`packages/rangojs-router/e2e/test-app` and `tests/cloudflare-basic` are not in
this table on purpose. Both render `Date.now()` in `Static()` and `Prerender`
handlers, so their main router gets a new version on every build, as it
should.

### Build time

Five `vite build` runs per app, wall-clock, median with the range. The base
commit and this branch were measured back to back, base first, on AC power
with a 1-minute load average between 2.7 and 3.5 from other work on the
machine. Same method as the proposal's baseline script (spawn `vite build`,
take the median); the step time is the phase's own timer, printed by the
build.

| App                                            | Before                | After                 | Change  | Version step (median, range) |
| ---------------------------------------------- | --------------------- | --------------------- | ------- | ---------------------------- |
| `tests/cloudflare-stress-demo` (26k routes)    | 2.46 s (2.45 to 2.76) | 2.47 s (2.46 to 2.52) | +0.01 s | 19.1 ms (18.8 to 20.5)       |
| `examples/cloudflare-multi-router` (4 routers) | 1.71 s (1.70 to 2.02) | 1.68 s (1.68 to 1.72) | -0.03 s | 10.9 ms (10.6 to 12.7)       |
| `tests/cloudflare-basic`                       | 3.82 s (3.79 to 3.92) | 3.82 s (3.79 to 3.84) | 0       | 19.2 ms (18.6 to 19.3)       |
| `packages/rangojs-router/e2e/test-app` (node)  | 3.92 s (3.88 to 4.35) | 3.91 s (3.88 to 3.99) | -0.01 s | 21.1 ms (20.3 to 21.2)       |

The proposal's pass mark was "every median within the base run's range". No
median is above its base range. Read the "Change" column as noise, not as a
speed-up: an earlier session of the same measurement, on the code before the
second review's fixes, had every app 30 to 70 ms slower (1.0% to 1.9%) and
`test-app` 30 ms above its base maximum. The two sessions bracket zero.

That table is from the quietest session, and it was measured before the last
two rounds of fixes (the name test on an external import, symlinks in a linked
package, the root-relative `outDir`). Every later back-to-back session ran
while other e2e suites loaded the machine (load up to 20, base ranges up to
1.7 s wide) and said more about the machine than the code. So the final
commits were measured another way: seven rounds, the base commit and then the
branch in each round, one build per app per side, so that a drift in load
lands on both. Load was 3.7 to 6.7.

| App                                    | Before, median (range) | After, median (range) | Median of the 7 paired differences |
| -------------------------------------- | ---------------------- | --------------------- | ---------------------------------- |
| `tests/cloudflare-stress-demo`         | 2.59 s (2.46 to 2.85)  | 2.52 s (2.45 to 3.64) | -23 ms                             |
| `examples/cloudflare-multi-router`     | 1.78 s (1.69 to 2.12)  | 1.72 s (1.68 to 1.90) | -10 ms                             |
| `tests/cloudflare-basic`               | 4.10 s (3.78 to 4.19)  | 4.06 s (3.89 to 4.49) | +71 ms                             |
| `packages/rangojs-router/e2e/test-app` | 4.03 s (3.86 to 4.61)  | 4.34 s (3.90 to 4.92) | +35 ms                             |

Single pairs ranged from 446 ms faster to 1071 ms slower, so this bounds the
effect at tens of milliseconds and does not resolve it further. A number for
a release note needs an idle machine; this one never was.

What does not move between sessions is the step's own timer: 19.4, 11.2, 21.5
and 21.1 ms on the final commits (median of 5), 0.5% to 0.8% of a build. The
proposal projected under 5 ms for the hashing; that was the cost of one sha256
over the server output. The step that shipped also reads the SSR output, makes
module ids portable, scans every chunk for file names, digests a shared chunk
once per distinct ownership and describes the installed externals. Outside
the step, the module graph is recorded in `generateBundle` and one more
transform plugin runs.

### Bundle guards

`pnpm check:bundle-guards`, before and after:

| Guard                                                | Before  | After   | Limit   |
| ---------------------------------------------------- | ------- | ------- | ------- |
| `tests/cloudflare-basic` client router chunk, gzip   | 47077 B | 47077 B | 47104 B |
| `tests/cloudflare-stress-demo` eager routes manifest | 315 B   | 314 B   | 2048 B  |

The client router chunk is byte-identical: it has the same content hash in
its file name in both builds. No version, and none of the code that computes
or resolves one, reaches the client bundle (`e2e/bundle-analysis.test.ts`
asserts it).

### Run time

At run time a version is a string in a table and a prefix on a key. A handler
resolves its pair once, when it is created. A store reads the request context
once more per key than before.

The added cost per key, measured in isolation on Node (2 million calls, median
of 7 rounds): building the prefix from the request's versions takes 62 ns
(54 to 93); with a store-level `version`, which is what every key cost before,
11 ns. A request builds a handful of keys, so this is well under a microsecond
per request.

The stress demo's throughput harness (`bench/run.ts --runs 3 --duration 4
--cold-runs 3`) was run on the base commit and on this branch in one session
and compared with `bench/compare.ts`. It calls all 16 throughput scenarios
"within variance", and the variance it reports is 44% to 124%, so this run
cannot show a change of the size above and nothing should be quoted from it
in either direction. The cache scenarios: `cached-hit` 141 to 126 req/s
(variance 93%), `cached-miss-unique` 128 to 117 req/s (79%). Scenarios that
never touch a cache moved more, in the same direction (`miss-root-probe` 265
to 116 req/s), which is the machine, not the code: the two runs were minutes
apart with other work in between. Cold start, the first request after a fresh
server start, was 34.5 ms before and 32.7 ms after on `/bench/first`.

A run-time claim would need the runbook's conditions (an idle machine, the
default 5 runs of 5 s). This one is recorded so the next reader does not have
to wonder whether it was tried.
