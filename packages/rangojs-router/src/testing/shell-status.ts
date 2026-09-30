/**
 * PPR shell-status testing primitives for @rangojs/router consumers.
 *
 * Companion to `cache-status.ts` (segment/document cache): this module covers
 * the **shell axis** (`ppr` path option → `x-rango-shell: HIT | MISS`) and
 * partial-navigation segment replay (`x-rango-ppr-replay: HIT`).
 *
 * ## Spike conclusions (plan 009)
 *
 * 1. **`dispatch` cannot exercise PPR.** It is deliberately RSC-free: no Flight,
 *    no SSR, no `handleRscRendering` commit point. Seeding `MemorySegmentCacheStore`
 *    + `ppr: true` on a response route is a no-op for shell serve/capture. The
 *    production path lives in `rsc/rsc-rendering.ts` + `rsc/shell-capture.ts`.
 *
 * 2. **Smallest status signals:** `x-rango-shell` (`HIT` | `MISS`) on document
 *    GETs, and `x-rango-ppr-replay` on partial requests to ppr routes. A replay
 *    HIT is reported only when matching consumes the captured segment record.
 *    Secondary unit signal: `store.getShell(shellCacheKey(url))` after a real
 *    capture flush (background `putShell`). There is no Flight flag for shell HIT.
 *
 * 3. **A real MISS → capture → HIT in unit tests:** `serveShellRequest`
 *    (`@rangojs/router/testing/flight`, serve-shell-request.ts) serves one
 *    request through the router's production handler and settles its
 *    background capture; a later request with the same store is a real HIT or
 *    partial replay. Its only stub is the HTML step (the SSR module).
 *    **Stays e2e-only:** real HTML (the prelude's `<body` gate, fizz resume of
 *    holes), browser resume of holes, live Cloudflare/Vercel runtimes (store
 *    test doubles work in unit), and build-time producer B bake. The unit layer
 *    must never stub a shell HIT response.
 *
 * Import from `@rangojs/router/testing` (Vitest) or `@rangojs/router/testing/e2e`
 * (Playwright — same pure helpers, no Vite virtuals).
 */

import { composeCacheKeys } from "../cache/cache-key-utils.js";
import {
  PPR_REPLAY_BYPASS_REASONS,
  PPR_REPLAY_STATUS_HEADER,
  SHELL_STATUS_HEADER,
  buildShellKey,
  partitionShellKey,
  type PprReplayBypassReason,
} from "../rsc/shell-capture-constants.js";
import {
  compileSearchParamsFilter,
  type CacheSearchParams,
} from "../cache/search-params-filter.js";

// The production header names and bypass reasons, from the React-free leaf
// the serve path reads them from.
export { PPR_REPLAY_STATUS_HEADER, SHELL_STATUS_HEADER };
export type { PprReplayBypassReason };

/** Values the serve path writes on `x-rango-shell`. */
export type ShellStatus = "HIT" | "MISS";

/** Parsed `x-rango-ppr-replay` value. */
export type PprReplayStatus =
  | { outcome: "HIT"; freshness: "fresh" | "stale" }
  | { outcome: "BYPASS"; reason: PprReplayBypassReason };

/** A target carrying response headers (a Response or a `{ headers }` object). */
export type ShellStatusTarget = Response | { headers: Headers };

/**
 * Shell store key for a document URL: the production `buildShellKey` (host +
 * pathname + sorted search + `:shell`) and `partitionShellKey`, both from the
 * React-free leaf `rsc/shell-capture-constants.ts`, so the testing barrel never
 * imports the shell-serve module (it pulls React).
 *
 * Accepts a `URL` or an absolute/relative request URL string (relative strings
 * resolve against `http://localhost`). Pass the router's `cache.searchParams`
 * config as `searchParams` when the app under test sets one — the production
 * key applies it, so the expected key must too. When the route's record is
 * partitioned by the request — its `cache({ key })`, or the store's
 * `keyGenerator` — its shell is too: pass the key that function returns for
 * the request as `partition` (appended URI-encoded; a result equal to the
 * default key partitions nothing, so pass none). Under nested keyed
 * `cache()` scopes, pass their `key()` results as an array, outermost first:
 * they compose as the production record key composes them
 * (`composeCacheKeys`).
 */
export function shellCacheKey(
  url: URL | string,
  searchParams?: CacheSearchParams,
  partition?: string | readonly string[],
): string {
  const resolved =
    typeof url === "string" ? new URL(url, "http://localhost") : url;
  const key = buildShellKey(resolved, compileSearchParamsFilter(searchParams));
  if (partition === undefined) return key;
  if (typeof partition === "string") return partitionShellKey(key, partition);
  // No key() results: no partition, as when `partition` is omitted.
  return partition.length === 0
    ? key
    : partitionShellKey(key, composeCacheKeys(partition));
}

function getHeaders(target: ShellStatusTarget): Headers {
  return target.headers;
}

const PPR_REPLAY_BYPASS_REASON_SET = new Set<string>(PPR_REPLAY_BYPASS_REASONS);

/**
 * Read `x-rango-shell` from a response. Returns `null` when the header is
 * absent (axis-1 / non-ppr / ineligible request).
 */
export function parseShellStatus(
  target: ShellStatusTarget,
): ShellStatus | null {
  const raw = getHeaders(target).get(SHELL_STATUS_HEADER);
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "HIT" || value === "MISS") return value;
  return null;
}

/**
 * Assert a document response's `x-rango-shell` header equals `expected`.
 * Throws when the header is missing, unrecognized, or mismatched.
 *
 * Use on real document GETs (e2e `page.request.get` / `router.fetch`). Do not
 * invent a HIT Response in unit tests — that fakes the serve path.
 */
export function assertShellStatus(
  target: ShellStatusTarget,
  expected: ShellStatus,
): void {
  const headerValue = getHeaders(target).get(SHELL_STATUS_HEADER);
  if (headerValue === null) {
    throw new Error(
      `assertShellStatus: response has no ${SHELL_STATUS_HEADER} header. ` +
        `The header is only set on document GETs to a ppr-declared route that ` +
        `the serve path considered (axis-1 fall-open and non-ppr routes omit it).`,
    );
  }
  const actual = headerValue.trim();
  if (actual !== expected) {
    throw new Error(
      `assertShellStatus: expected "${expected}" but got "${actual}".`,
    );
  }
}

/** Parse the dedicated PPR partial-navigation replay decision header. */
export function parsePprReplayStatus(
  target: ShellStatusTarget,
): PprReplayStatus | null {
  const raw = getHeaders(target).get(PPR_REPLAY_STATUS_HEADER)?.trim();
  if (!raw) return null;

  const [outcome, detail, ...extra] = raw.split(";").map((part) => part.trim());
  if (extra.length > 0 || !detail) return null;

  if (outcome === "HIT") {
    const freshness = detail.match(/^freshness=(fresh|stale)$/)?.[1];
    if (freshness === "fresh" || freshness === "stale") {
      return { outcome, freshness };
    }
    return null;
  }

  if (outcome === "BYPASS") {
    const reason = detail.match(/^reason=(.+)$/)?.[1] as
      | PprReplayBypassReason
      | undefined;
    if (reason && PPR_REPLAY_BYPASS_REASON_SET.has(reason)) {
      return { outcome, reason };
    }
  }

  return null;
}

/** Assert a partial response's PPR replay outcome and freshness/reason. */
export function assertPprReplayStatus(
  target: ShellStatusTarget,
  expected: PprReplayStatus,
): void {
  const raw = getHeaders(target).get(PPR_REPLAY_STATUS_HEADER);
  if (raw === null) {
    throw new Error(
      `assertPprReplayStatus: response has no ${PPR_REPLAY_STATUS_HEADER} header. ` +
        "The header is set on partial requests to ppr-declared routes.",
    );
  }

  const actual = parsePprReplayStatus(target);
  if (!actual) {
    throw new Error(
      `assertPprReplayStatus: unrecognized ${PPR_REPLAY_STATUS_HEADER} value "${raw}".`,
    );
  }

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `assertPprReplayStatus: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}.`,
    );
  }
}
