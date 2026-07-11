/**
 * PPR shell-status testing primitives for @rangojs/router consumers.
 *
 * Companion to `cache-status.ts` (segment/document cache): this module covers
 * the **shell axis** (`ppr` path option → `x-rango-shell: HIT | MISS`).
 *
 * ## Spike conclusions (plan 009)
 *
 * 1. **`dispatch` cannot exercise PPR.** It is deliberately RSC-free: no Flight,
 *    no SSR, no `handleRscRendering` commit point. Seeding `MemorySegmentCacheStore`
 *    + `ppr: true` on a response route is a no-op for shell serve/capture. The
 *    production path lives in `rsc/rsc-rendering.ts` + `rsc/shell-capture.ts`.
 *
 * 2. **Smallest HIT signal:** response header `x-rango-shell` (`HIT` | `MISS`),
 *    always on document GETs to a ppr route that the serve path considered.
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

/** Production header name (`rsc/shell-serve.ts` `SHELL_STATUS_HEADER`). */
export const SHELL_STATUS_HEADER: string = "x-rango-shell";

/** Values the serve path writes on `x-rango-shell`. */
export type ShellStatus = "HIT" | "MISS";

/** A target carrying response headers (a Response or a `{ headers }` object). */
export type ShellStatusTarget = Response | { headers: Headers };

/**
 * Shell store key for a document URL — same formula as production
 * `buildShellKey` in `rsc/shell-serve.ts` (host + pathname + sorted search +
 * `:shell`). Kept here so the testing barrel never imports the shell-serve
 * module (it pulls React). A parity test pins the two implementations.
 *
 * Accepts a `URL` or an absolute/relative request URL string (relative strings
 * resolve against `http://localhost`).
 */
export function shellCacheKey(url: URL | string): string {
  const resolved =
    typeof url === "string" ? new URL(url, "http://localhost") : url;
  const sorted = sortedSearchString(resolved.searchParams);
  const searchSuffix = sorted ? `?${sorted}` : "";
  return `${resolved.host}${resolved.pathname}${searchSuffix}:shell`;
}

function getHeaders(target: ShellStatusTarget): Headers {
  return target.headers;
}

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
