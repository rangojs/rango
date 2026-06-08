# `[FILE_NAME_CONFLICT]` build warnings — analysis & resolution

If you've hit a wall of `[FILE_NAME_CONFLICT]` warnings on a production build (the
classic shape is 1 CSS + 12 woff2 fonts) and you're wondering whether to worry —
you don't, and this explains why, plus exactly what rango does about it.

**TL;DR:** those warnings are benign duplicate emits of byte-identical,
content-hashed assets from `@vitejs/plugin-rsc`'s cross-environment asset copy.
rango's shared `onwarn` (`src/vite/utils/shared-utils.ts`) now suppresses **only**
the content-hashed variety; a collision on a stable (non-hashed) name still
surfaces, because that one could be a genuine problem. The rest of this note is
the confirmed mechanism, the three bugs the first cuts had, why consumer-side
suppression is the right fix, the sourcemap-safety argument, and why the warning
is not reproducible by an in-repo build fixture.

## Symptom

```
[FILE_NAME_CONFLICT] The emitted file assets/index-DlGNrvnU.css overwrites a
previously emitted file of the same name.
[FILE_NAME_CONFLICT] The emitted file assets/inter-latin-wght-normal-Dx4kXJAl.woff2
overwrites a previously emitted file of the same name.
…  (reporter: 1 CSS + 12 .woff2; build still exits 0)
```

The filenames are content-hashed, so "same name" means identical bytes. The MD5
of each re-emitted asset matches across every environment output:

| Asset                | client    | rsc       | rsc/ssr   |
| -------------------- | --------- | --------- | --------- |
| `index-DlGNrvnU.css` | 404f3dd5… | 404f3dd5… | 404f3dd5… |
| `inter-latin-…woff2` | 260c81a4… | 260c81a4… | 260c81a4… |

The final files are correct; nothing is lost.

## Root cause (confirmed)

`@vitejs/plugin-rsc`'s `rsc:virtual:vite-rsc/assets-manifest` plugin, in its
**client-environment** `generateBundle`, copies every `importedCss` /
`importedAssets` entry of the **rsc** bundle into the client output:

```js
// node_modules/@vitejs/plugin-rsc/dist/plugin-*.js (~line 1063)
const assets = new Set(/* rsc bundle chunks' importedCss + importedAssets */);
for (const fileName of assets) {
  const asset = rscBundle[fileName];
  this.emitFile({
    type: "asset",
    fileName: asset.fileName,
    source: asset.source,
  });
}
```

The `emitFile` passes an **explicit content-hashed `fileName`** with no check
against the client bundle. When the client bundle already produced that identical
asset, rollup's `reserveFileNameInBundle` warns `FILE_NAME_CONFLICT`
**synchronously at emit time** (via `this.options.onLog`), so a later
`generateBundle` hook cannot prevent it. Because the colliding name is
content-hashed, the two copies are byte-identical — the warning is cosmetic.

## The fix (three bugs)

`onwarn` in `src/vite/utils/shared-utils.ts` gains a 7th suppression, scoped to
content-hashed asset names: it parses the colliding filename out of the message
and suppresses only when the name ends with a `-` separator + a fixed-length
(default 8) base64url hash holding at least one uppercase letter or digit. A
collision on a stable name (`manifest.json`, `loading-skeleton.css`) is **not**
suppressed and still reaches the default handler — it could be a genuine
different-content overwrite. Pinned by `src/vite/__tests__/onwarn.test.ts` (19
cases, incl. hashes that themselves contain `-`/`_`) and a 200k-case fuzz during
development (0 mismatches, 0 stable-name leaks).

The part worth internalizing: this looked like one fix but was really three
independent bugs — they surfaced only from re-testing the suppression on a real
app, and the suppression works only with **all three** fixed.

**1. Wiring — `onwarn` must live on the CLIENT environment, not just top-level.**
The conflicts are emitted by the client-environment build. In the Vite 8 +
`@cloudflare/vite-plugin` environment-builder stack, an environment build does
**not** consult the top-level `build.rollupOptions.onwarn` — instrumentation
showed the top-level handler invoked **0×** for these conflicts, while a handler
on `environments.client.build.rollupOptions.onwarn` was invoked for **all** of
them. So `onwarn` is now wired on the client env (next to `manualChunks`) in both
presets; the top-level handler is kept for warnings emitted in non-client phases.
(An earlier "wiring is fine" conclusion was a false positive — the
`INEFFECTIVE_DYNAMIC_IMPORT` warning used to "prove" it actually routes through a
different, non-client phase than the client-env `emitFile`-time conflict.)

**2. Matcher — unanchored AND quote-optional.** The `message` handed to `onwarn`
is Vite's DISPLAY string, not rollup's raw log: Vite prefixes it with an ANSI
sequence + a `[CODE] ` label AND strips the quotes rollup puts around the filename.
The delivered literal is:
`\x1b[33m[FILE_NAME_CONFLICT] \x1b[0mThe emitted file assets/index-DlGNrvnU.css overwrites …`.
So the match is **unanchored** (a `^The emitted file` anchor sits behind the prefix
and never matches) and **quote-optional** (`"?([^"\s]+)"?` — the non-whitespace
capture stops at the space before `overwrites` in Vite's unquoted form, or the
closing quote in the raw rollup form). The unit test feeds the real prefixed +
unquoted form, so a re-anchored or quote-required regression fails it.

**3. Hash extraction — fixed-length trailing run, not split-on-last-`-`.** Vite /
rolldown content hashes are **base64url** (`[A-Za-z0-9_-]`), so the hash can
itself contain `-` or `_`. The first cut found the hash with
`stem.slice(stem.lastIndexOf("-") + 1)` — splitting on the **last** `-`, which
lands **inside** a dash-bearing hash and extracts a too-short tail
(`…-Cabi7G8-` → `""`, `…-CkhJZR-_` → `"_"`), so those (real, in the reporter's 12
webfonts) leaked. The fix takes the trailing `HASH_LEN` (8) chars and requires a
`-` separator immediately before them, instead of scanning for a separator the
hash alphabet can impersonate. (`HASH_LEN` tracks Vite's default `[hash]` width;
bump it if an app sets a custom `assetFileNames` hash length — until then the
fail-safe is "the warning reappears", never a wrong suppression.)

## Why consumer-side suppression (not a dep bump or a patch)

The obvious instincts are to upgrade the dependency or patch it. Neither works,
and here's the case for filtering it on our side instead:

- **No upstream fix.** As of `@vitejs/plugin-rsc@0.5.27` (latest) the emit block is
  byte-identical to 0.5.26 — no `if (!bundle[fileName])` guard, no config flag, no
  issue/PR. The relevant upstream PR #1112 (shipped in 0.5.26) reworked _which_
  assets copy (security scoping), not the emit mechanics. **Upgrading does not
  help.** Consumer-side suppression is the expected resolution.
- **Industry precedent for narrow `onwarn`.** React Router v7 and Remix both ship a
  `build.rollupOptions.onwarn` — scoped to `MODULE_LEVEL_DIRECTIVE` + `"use client"`
  with user-handler pass-through. Targeted, code-specific suppression is the
  blessed pattern (they don't filter FILE_NAME_CONFLICT only because they don't do
  plugin-rsc's cross-environment copy). Waku ships no `onwarn` and simply tolerates
  the warning.
- **Consistent with this repo.** rango already centralizes 6 build-artifact
  suppressions in this same `onwarn`; this is the 7th, narrowed.
- **A `pnpm patch` of plugin-rsc's dist** would be non-idiomatic (no patch infra in
  the repo) and fragile across version bumps.

## Sourcemap safety

A natural worry is whether sourcemaps stay correct. They do, and the `onwarn`
filter can't affect them either way:

- Rollup's `EmittedAsset` / `OutputAsset` have **no `map` field** — the re-emit
  copies only `source`. `.map` files are generated post-emission from content, so
  byte-identical copies ⇒ byte-identical sourcemaps pointing at the same source.
- `.map` files are not emitted through the copy loop, so they do not double-warn.
- `onwarn` is a logging callback invoked **after** the emit decision; returning
  early suppresses the console line only — it cannot alter bundle output or
  sourcemap generation.

## Reproduction is topology-specific (no in-repo build fixture)

This is the part that makes it awkward to test: the warning fires only under a
**host-router multi-app** build — sub-apps loaded via `.lazy(() => import())`, a
wide shared client tree, and a shared webfont-CSS reachable across apps (the
reporter's cloudflare app, React Compiler enabled). It was verified that the
warning does **not** fire — even with the suppression disabled — under any
single-router in-repo app:

- **node preset (`e2e/mini`):** client-component CSS never enters the rsc bundle,
  so the cross-environment copy never happens. A server-side `import "./x.css"`
  (the other route in) parse-fails universally — plugin-rsc's `rsc:use-client`
  transform JS-parses any `.css` in the rsc environment.
- **cloudflare single-router, non-split:** the shared CSS merges into one entry
  chunk; the font emits once; no double-emit.
- **cloudflare single-router, `clientChunks`-split:** the shared CSS becomes its
  own asset shared across `app-*` chunks; still no collision.

Because no single-router fixture can trigger it, coverage is the deterministic
unit test above plus the reporter's verified-on-real-app result, rather than an
e2e build assertion. (Note: the repo's 6 pre-existing `onwarn` suppressions have
no tests at all — the unit test here exceeds that bar.)

## Follow-up

Contribute the `if (!bundle[fileName])` skip-guard upstream to
`@vitejs/plugin-rsc`'s assets-manifest copy loop (the real root-cause fix), then
remove this suppression. The code comment in `onwarn` flags this.

## Out of scope

A separate build warning (`wrangler.do.json` rules ignored under Vite) is app-side
/ `@cloudflare/vite-plugin`, not rango.
