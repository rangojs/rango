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
called through any router's action or loader endpoint. That default is not
special to registries. It is the one ownership rule (`ownersOf`), and it
applies to every input below that is not a chunk the walk reaches: an input
has subject modules, it belongs to the routers that reach one of them, and to
EVERY router when none does. What nobody can be shown to run is not safe to
leave out.

Five things a router's output depends on are in none of its chunks. Each is
added explicitly, and all but the first through that rule:

- **Its lazy route manifest** (`virtual:rsc-router/routes-manifest/<routerId>`),
  loaded through the registry by `ensureRouterManifest`.
- **Its `clientUrls()` projections.** A route group defined in a
  `"use client"` module reaches the server as a projection the build takes of
  that module: which loaders each route declares, `loading`, transitions, the
  route ids. The server materializes the group from it. The projection ships
  in the routes registry (the host entry's chunk), the client module is a
  reference proxy in the server graph, and the route trie holds none of it, so
  a route that switched loaders changed nothing a lazily mounted app hashed.
  Each projection is added as `client-urls <module>`; its subject is the
  client module.
- **The encryption key.** plugin-rsc writes it to
  `__vite_rsc_encryption_key.js` next to the RSC entry and has chunks import
  that file at run time; it writes the file only when a rendered chunk reads
  the key. The key's subjects are the modules that encrypt. Importing
  plugin-rsc's encryption runtime is not the test: plugin-rsc prepends that
  import to every `"use server"` module, so it would be nearly every router,
  and without a stable key nearly every app would get new versions on every
  build. The test is whether the module USES the namespace the import binds
  (`usesEncryptionRuntime`), which plugin-rsc emits only for an inline action
  that closes over a value. It is deliberately not the name of the function
  called, and it fails closed three ways:
  - a module whose code or whose import of the runtime cannot be read counts
    as encrypting;
  - a key file with no module recognised as encrypting means the recognition
    failed (a rename in plugin-rsc), so the key is every router's;
  - a module that encrypts while the key file is missing fails the build.

  An app that does not encrypt has neither, and no key in any version.

- **The stylesheets of its server components.** The wrapper plugin-rsc puts
  around a server component that imports CSS reads the URLs at run time from
  `__vite_rsc_assets_manifest.js` (`serverResources["<module>"]`), a file
  written after all bundles. A CSS-only change therefore left every server
  chunk identical while cached Flight kept linking the old file. Each entry is
  added as `server-css <module>`; its subject is the module plugin-rsc
  generates to render its links
  (`virtual:vite-rsc/css?type=rsc&id=<module>`).
- **What the bundle leaves external.** This one is owned through the chunk
  that imports it, not through `ownersOf`: an import is an attribute of a file
  the walk reached, and "every router when none owns it" would hand a
  dependency of the host entry to every app. The rule for what an external
  import is, is in one place (`classifyExternal`):

  | The import is                                                                                          | The version covers                                                               |
  | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
  | provided by the runtime: `node:fs`, bare `fs`, `cloudflare:workers`, `workerd:`, `bun:`, a `data:` URL | nothing; a build cannot install or change it                                     |
  | another plugin's marker for a file the hash already covers                                             | nothing more; see below                                                          |
  | a package (`pkg`, `@scope/pkg/sub`)                                                                    | what is installed: `name@version` of the package and of everything it depends on |
  | a relative or absolute path                                                                            | the file's bytes                                                                 |
  | anything else (`https:`, `npm:`, a name npm would reject)                                              | nothing the build can read                                                       |

  A package that is not installed where the build can find it, a path that
  does not resolve and every import of the last kind get a value unique to
  the build: the routers importing them get a new version on every build, and
  the build names them. They are never left out. Left out, a lockfile bump of
  that package changes what the server renders and no version.

  The Cloudflare and Vercel presets bundle everything, so this is mostly the
  node preset, which bundles only what needs the React server condition; any
  other dependency stays `from "pkg"` in the chunk, whichever version is
  installed (`src/vite/discovery/installed-packages.ts`). A registry
  package's code is fixed by its version. A linked workspace package is not;
  Vite bundles those unless the config lists one in `resolve.external`, and
  then its files are digested: every file in its directory but
  `node_modules` and `.git`, symlinks followed, so a build artifact in there
  that differs from build to build (a log, a `.tsbuildinfo`) moves the
  version, and a file that cannot be read fails the build.

  The two markers: @cloudflare/vite-plugin imports a text or wasm module as
  `__CLOUDFLARE_MODULE__<type>__<path>__CLOUDFLARE_MODULE__` and emits the
  file as a bundle asset the chunk names, which is hashed as one; plugin-rsc
  resolves `virtual:vite-rsc/assets-manifest` as external, and that manifest
  is covered entry by entry (`server-css`) and, for the client asset names,
  by the document version.

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

A chunk's bytes say two kinds of things: what was built, and where and how the
build ran. Only the first belongs in a version, so three things are taken out
before hashing (`digestBundle`), each for a measured reason:

- **The hashed names of bundle files.** A chunk's file name carries its
  content hash, and every chunk that imports it has the name in its bytes. So
  one router's change renamed its chunk and moved the hash of every chunk
  naming it, including shared ones. Each file is digested once with every
  such name replaced by one token (a NUL, which no chunk's text holds, so a
  reference cannot be mistaken for the code around it), and the files those
  names referred to are kept as an ordered list. What a router hashes for the file is that digest
  plus the list, each entry as the target's identity (its un-hashed name plus
  a digest of the module ids inside it) when the router owns the target, and
  as one fixed token when it does not. No chunk is hashed twice.
- **The server-reference map's body** (`stripServerReferenceMap`). It lists
  every action export of the build and sits in a chunk every router runs.
  Hashed as is, adding an action to one app changed every app's version. Each
  module it names is hashed by the routers that reach it, so nothing is lost.
  This works on the bundler's region comments; a minified server build has
  none and keeps the map in the hash, which clears more, never less.
- **The paths in region comments** (`stripRegionPaths`). The bundler prints
  each module's path above its code, and that path is about the build, not
  the code:
  - it is relative to the directory `vite build` was started from, not to
    the Vite root, so `vite build` in the app and `vite build apps/web` from
    the repository root printed different comments and gave different
    versions;
  - for a dependency it runs through the pnpm store directory, whose name
    ends in the peers the package was installed against
    (`.pnpm/@vitejs+plugin-rsc@0.5.35_react@19.3.0_<hash>/`). Bumping any
    package in that peer set (TypeScript is an optional peer of many) renamed
    the directory and moved every version with no change in bundled code;
  - a virtual module's id is printed verbatim, and plugin-rsc's server CSS
    module has its importer's absolute path in the id, so two checkout
    directories built to two versions.

  The code under the comment is hashed either way. Setting rolldown's `cwd`
  would have fixed the first of the three and changed the bytes that ship;
  changing the hash input fixes all three and ships the same bytes.

Module ids need the same care, because a chunk's identity is derived from the
ids of the modules inside it (`portableModuleId`): the pnpm store directory is
reduced to `name@version` there too, and so is one id that carries the working
directory. plugin-rsc names a client-reference group after the facade module
of its server chunk, made relative to the root; for a virtual facade
(@cloudflare/vite-plugin's worker entry) `path.relative` resolves the id
against the working directory first, and the group's module id became
`…/group/facade:__/__/\0virtual:cloudflare/worker-entry` when vite was started
two directories up. That was found by building one app from two directories,
not by a test: the fixture has no virtual facade.

**Bundle assets are hashed as bytes**, not scanned: a large route manifest is
staged as a `.txt` text module on Cloudflare (3.47 MB in the stress demo).

The SSR output gets exactly this treatment, through the same function. It is
unminified too, its chunks are named by content hashes of bytes that include
region comments, and the document version covers it. Hashed raw, with its file
names, it made the document version depend on the working directory even after
the RSC side was fixed.

What remains tied to how the build ran is the client build: its file names
are part of the document version as they are, because stored HTML and open
tabs hold exactly those names. They are content hashes of minified code, which
has no region comments. A client build with `build.minify: false` does have
them, and then the document version depends on the working directory and the
pnpm store layout again.

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
those inputs, each a name and a digest.

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

There is one way to get versions and no stand-in for it. The rule, for every
input: when the build cannot determine it, the build fails, or the version
changes on every build. A version never silently stays the same, because that
is the one outcome nobody notices until a stale entry is served.

| The build cannot determine                                                                                    | What happens                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| a bundle: the RSC, SSR or client build did not record its files                                               | the build fails                                                              |
| a file a bundle lists that is not in its output directory, or that cannot be read                             | the build fails                                                              |
| plugin-rsc's assets manifest: missing, or `serverResources` is not where it was                               | the build fails                                                              |
| which chunk holds the version module, or the placeholder in it                                                | the build fails                                                              |
| the encryption key file, while a module encrypts                                                              | the build fails                                                              |
| which module encrypts, while there is a key file                                                              | the key is in every router's version                                         |
| what an external import resolves to: a package that is not installed, a path that does not resolve, a URL     | a value unique to the build for the routers importing it; the build names it |
| which router runs a registry target, a payload's handler, a `clientUrls()` module or a server component's CSS | it is in every router's version                                              |

A fallback stamp would quietly bring back "every deploy clears the cache",
and nobody reads a warning in a build log. An unreplaced token is a free
identifier, so even a build that somehow skipped the step throws a
`ReferenceError` when the module evaluates; it cannot serve with a version
that never changes.

A router the build cannot attribute (its module is not in the server bundle)
is not an error: it serves with the whole-build pair, which any change moves,
and the build log marks its line `(whole build)`.

The phase returns the table, and the same hook hands it to the build-time PPR
shell capture (`runShellPrerenderPhase`), which stamps each shell with the
document version of the router that owns it.

Every build prints the versions, and leaves what each one was computed from in
`node_modules/.rangojs-router-build/cache-versions.json`. A version is one
hash, so a changed version says nothing about what changed; diffing two
builds' files names the chunk, payload or key that did. The file also lists,
once each:

- `ssrAndClient`: what the `ssr-and-client` input of every document version
  is a digest of (`base`, the SSR files, what they leave external, the client
  asset names), so a moved document version can be traced to a file as well;
- `unownedFiles`: the server files no router owns, which is the host entry
  of lazily mounted apps and whatever else is in the whole-build pair only.
  If a file you expected an app to depend on is there, a change to it keeps
  that app's cache.

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

That makes the request context load-bearing for every cache write, and most
writes are deferred: `cacheRoute` calls `store.set` inside
`ctx.waitUntil()`, and so does the document cache on a MISS. You might ask
whether the platform always carries the request's async context into that
deferred task. Node and miniflare do. Deployed workerd lost it once, in
`"use cache"` background revalidation, which is why that bug could never be
reproduced locally. It is not the general case: `cacheRoute` already needs the
request context on `main` (it throws without one), and route caching works on
deployed workers, so these writes keep their context today. This is a
hardening, not a fix for a failure anyone has seen on this path.

What it guards against: a store that builds its key with no context reads no
router and falls back to the whole-build pair, and an entry under the
whole-build pair is one no router with its own version ever reads. Caching
would silently never hit. So `ctx.waitUntil()` re-enters the context a task
was scheduled under, once, where every task is scheduled
(`src/server/request-context.ts`). The test produces the loss by scheduling
from an async scope outside any request
(`src/cache/__tests__/background-write-versions.rsc-test.tsx`); without the
re-entry the document write lands under the whole-build version and the
segment write does not happen at all.

What cannot be tested locally is whether some other path loses the context.
For that there is a log line: `getCacheVersions()` warns, once per process,
when it falls back to the whole-build pair in a build whose routers have
versions of their own. If that line shows up in a production log, a store
operation ran outside a request, and the entries it wrote are not being read.

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
| The directory `vite build` is started from                                   | kept        | kept        |
| Which peers pnpm installed a bundled dependency against                      | kept        | kept        |
| A blank line or a comment above `createRouter()` (the router id)             | kept        | kept        |
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
  build without a stable key would have cleared nearly every cache. The second
  asked whether a module calls `encryptActionBoundArgs(`, which was right
  until plugin-rsc renames it, and then put the key in no version without a
  word. The test is now any use of the runtime's namespace, with the key file
  as a second, independent signal ("Which code is a router's").
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
  to building their trie at run time. A first fix took the line from the file
  on disk, which made the two agree and kept the other half of the problem: a
  blank line or a comment added above the call still changed the id, and with
  it the state cookie name, the route manifest chunk name and the router's
  versions. Nothing else reads the line, so the id is now a hash of the
  root-relative path and the call's position among the file's
  `createRouter()` calls (`routerId` in
  `src/vite/plugins/expose-ids/router-transform.ts`). Every router's id
  changes once with this release.
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
- **Store operations outside a request, other than through `ctx.waitUntil()`.**
  That path re-enters the request context ("At run time"). `CFCacheStore`
  also hands work to the platform's own `waitUntil` (KV-to-L1 promotion,
  evictions), started inside the request; three of those build a key after an
  `await`. They depended on the context for the key's host before this work,
  so the version adds no new dependency there, and they were left alone. The
  once-per-process warning in `getCacheVersions()` is what would show a loss.
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
- `src/vite/__tests__/cache-versions-build.test.ts`: eighteen real
  `vite build` runs of a two-app host fixture on the node preset, one per kind
  of change: server text, a route, a client component, a shared module, the
  key, no bound action arguments at all, an action only a client component
  imports, a new action, the host
  entry, code only the mounted handler reaches, a `clientUrls()` route that
  declares another loader, a server component's stylesheet, an external
  dependency and one of its dependencies, lines added above
  `createRouter()`, the same source in a second directory, and the same
  source built from a second working directory (`vite build app` from the
  parent).
- `src/vite/discovery/__tests__/installed-packages.test.ts` and
  `router-versions-phase.test.ts`: the phase against files on disk.
- `src/cache/cf/__tests__/cf-cache-store-versions.test.ts` and
  `src/cache/vercel/__tests__/vercel-cache-store-versions.test.ts`: key per
  family, and the rollback case.
- `src/cache/__tests__/background-write-versions.rsc-test.tsx`: a segment
  write and a document write deferred with `waitUntil`, run outside the
  request's async context, are keyed with the serving router's versions.
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
2026-10-04, on the code as it ships; the retention baseline and the run-time
numbers on 2026-10-03, before the review fixes. The path those run-time
numbers measure, a key built inside a request, is the same today: one read of
the request context.
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
| First request                                     | `23fd2fe84aa30f37 / 177c32dc85db47af` | `1791079052649` | stored |
| Second request, same server                       | `23fd2fe84aa30f37 / 177c32dc85db47af` | `1791079052649` | hit    |
| Server restarted, same build                      | `23fd2fe84aa30f37 / 177c32dc85db47af` | `1791079052649` | hit    |
| Rebuilt with no source change, first request      | `23fd2fe84aa30f37 / 177c32dc85db47af` | `1791079052649` | hit    |
| Rebuilt after a server-code change, first request | `4b809141ff8ccf94 / fcb123fd8c934060` | `1791079059626` | miss   |

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
than assumed, and sampled again after every change to what is hashed. The
counts below are from the code as it ships.

| Build                                                                        | Runs | Distinct version tables |
| ---------------------------------------------------------------------------- | ---- | ----------------------- |
| `examples/cloudflare-multi-router` (4 routers), sequential                   | 10   | 1                       |
| `examples/vercel-multi-router` (2 routers), sequential                       | 10   | 1                       |
| `tests/cloudflare-stress-demo`, sequential                                   | 6    | 1                       |
| Test fixture (node preset, 2 routers), concurrent, each in its own directory | 44   | 1                       |

And from two working directories, `vite build` in the app against
`vite build <app>` from the repository root:

| Build                              | Same table from both directories     |
| ---------------------------------- | ------------------------------------ |
| `examples/vercel-multi-router`     | yes                                  |
| `examples/cloudflare-multi-router` | yes                                  |
| `tests/cloudflare-stress-demo`     | yes                                  |
| Test fixture, in the build test    | yes (`cache-versions-build.test.ts`) |

What the samples caught on the way, which is the reason to keep taking them:

| Sample                                                                     | Runs | Distinct tables |
| -------------------------------------------------------------------------- | ---- | --------------- |
| The fixture before `stableRscOutput` renamed the manifest import           | 10   | 2               |
| The stress demo while its Text-module import counted as an unknown package | 6    | 6               |
| `vercel-multi-router` from two directories, region paths still hashed      | 2    | 2               |
| The stress demo from two directories, the group id still carrying the path | 2    | 2 (document)    |

One fixture build in ten came out with a different local name for one import,
which is why the rename exists. The stress demo is the only app in the first
table whose route manifest is large enough to ship as a workerd Text module:
@cloudflare/vite-plugin imports it through a marker specifier that looked
like a package nobody had installed, and a package the build cannot find gets
a per-build value on purpose (`classifyExternal` now knows the marker). The
last two rows are the working directory, in region comments and then in one
module id ("What is hashed"). No unit test saw any of the four; each has one
now, and the Cloudflare cache-version e2e builds with `RANGO_MANIFEST_TEXT=1`.

`packages/rangojs-router/e2e/test-app` and `tests/cloudflare-basic` are not in
these tables on purpose. Both render `Date.now()` in `Static()` and
`Prerender` handlers, so their main router gets a new version on every build,
as it should. `tests/cloudflare-basic` was left out of the second-working-directory sample
because `buildEnv: "auto"` read the wrangler config from the working directory
and its build-time prerender of `/build-env` failed from another one (#1037,
fixed: the config is read from the Vite root).

### Build time

Wall-clock time of `vite build`, measured interleaved: seven rounds, the base
commit and then this branch in each round, one build per app per side, so a
drift in machine load lands on both. AC power, 1-minute load average 1.0 to
3.9. The step time is the phase's own timer, printed by the build.

| App                                            | Before, median (range) | After, median (range) | Median of the 7 paired differences | Version step (median, range) |
| ---------------------------------------------- | ---------------------- | --------------------- | ---------------------------------- | ---------------------------- |
| `tests/cloudflare-stress-demo` (26k routes)    | 2.46 s (2.40 to 2.48)  | 2.46 s (2.45 to 2.47) | -1 ms                              | 23.6 ms (23.3 to 24.5)       |
| `examples/cloudflare-multi-router` (4 routers) | 1.67 s (1.66 to 2.04)  | 1.70 s (1.69 to 1.70) | +24 ms                             | 15.0 ms (14.8 to 16.1)       |
| `tests/cloudflare-basic`                       | 3.77 s (3.73 to 3.82)  | 3.81 s (3.81 to 3.83) | +36 ms                             | 22.0 ms (21.8 to 33.5)       |
| `packages/rangojs-router/e2e/test-app` (node)  | 3.87 s (3.86 to 4.22)  | 3.89 s (3.88 to 3.91) | +19 ms                             | 28.6 ms (28.5 to 29.2)       |

The proposal's pass mark was "every median within the base run's range". All
four meet it. The build is between unchanged and 1.4% slower. A first run of
the same measurement, three small edits earlier, gave -4, +24, +49 and +1 ms.

The proposal projected under 5 ms for the hashing; that was the cost of one
sha256 over the server output. The step that shipped takes 15 to 29 ms, 0.6%
to 1.0% of a build: it reads the RSC and the SSR output, takes region paths
and file names out of every chunk, makes module ids portable and describes
the installed externals. Outside the step, the module graph is recorded in
`generateBundle` and one more transform plugin runs.

Earlier sessions of this measurement, back to back instead of interleaved,
ran while other e2e suites loaded the machine (load up to 20, base ranges up
to 1.7 s wide) and said more about the machine than the code. They are not
reported.

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
