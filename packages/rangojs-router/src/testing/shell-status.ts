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
 * 3. **Stays e2e-only:** live MISS → background capture → HIT (needs real
 *    `captureShellHTML` / React `prerender` + resume fizz), browser resume of
 *    holes, Cloudflare/Vercel live stores, nonce/eligibility fall-open, and
 *    build-time producer B bake. Unit layer dogfoods the **store family + key
 *    identity + header assert**; it must never stub a shell HIT response.
 *
 * Import from `@rangojs/router/testing` (Vitest) or `@rangojs/router/testing/e2e`
 * (Playwright — same pure helpers, no Vite virtuals).
 */

import { sortedSearchString } from "../cache/cache-key-utils.js";
import {
  compileSearchParamsFilter,
  type CacheSearchParams,
} from "../cache/search-params-filter.js";

/** Production header name (`rsc/shell-serve.ts` `SHELL_STATUS_HEADER`). */
export const SHELL_STATUS_HEADER: string = "x-rango-shell";

/** Partial-navigation replay decision header from `rsc/rsc-rendering.ts`. */
export const PPR_REPLAY_STATUS_HEADER: string = "x-rango-ppr-replay";

/** Values the serve path writes on `x-rango-shell`. */
export type ShellStatus = "HIT" | "MISS";

const PPR_REPLAY_BYPASS_REASONS = [
  "method",
  "dynamic",
  "nonce",
  "store-unavailable",
  "passive-read-unsupported",
  "no-navigation-context",
  "prerender-store",
  "intercept",
  "cache-disabled",
  "read-error",
  "no-entry",
  "invalid-version",
  "corrupt-entry",
  "handler-live-holes",
  "transition-when",
  "no-segment-snapshot",
  "snapshot-miss",
  "explicit-cache-hit",
  "stale-build-entry",
] as const;

/** Bounded reasons a PPR partial request can fall open to ordinary matching. */
export type PprReplayBypassReason = (typeof PPR_REPLAY_BYPASS_REASONS)[number];

/** Parsed `x-rango-ppr-replay` value. */
export type PprReplayStatus =
  | { outcome: "HIT"; freshness: "fresh" | "stale" }
  | { outcome: "BYPASS"; reason: PprReplayBypassReason };

/** A target carrying response headers (a Response or a `{ headers }` object). */
export type ShellStatusTarget = Response | { headers: Headers };

/**
 * Shell store key for a document URL — same formula as production
 * `buildShellKey` in `rsc/shell-serve.ts` (host + pathname + sorted search +
 * `:shell`). Kept here so the testing barrel never imports the shell-serve
 * module (it pulls React). A parity test pins the two implementations.
 *
 * Accepts a `URL` or an absolute/relative request URL string (relative strings
 * resolve against `http://localhost`). Pass the router's `cache.searchParams`
 * config as `searchParams` when the app under test sets one — the production
 * key applies it, so the expected key must too.
 */
export function shellCacheKey(
  url: URL | string,
  searchParams?: CacheSearchParams,
): string {
  const resolved =
    typeof url === "string" ? new URL(url, "http://localhost") : url;
  const sorted = sortedSearchString(
    resolved.searchParams,
    compileSearchParamsFilter(searchParams),
  );
  const searchSuffix = sorted ? `?${sorted}` : "";
  return `${resolved.host}${resolved.pathname}${searchSuffix}:shell`;
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
