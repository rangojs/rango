/**
 * React-free leaf of the PPR shell path: its constants, the shell key
 * builders, the status header names and bypass reasons, and the once-per-key
 * warning registry. The ssr graph (ssr/index.tsx), the testing barrels
 * (testing/shell-status.ts) and cookie-store.ts import from here without
 * pulling the capture orchestration module or shell-serve.ts (React).
 */

import {
  routerKeyPrefix,
  sortedSearchString,
} from "../cache/cache-key-utils.js";
import type { SearchParamsFilter } from "../cache/search-params-filter.js";

/**
 * Default upper bound on the capture prerender wait before forcing the abort
 * that freezes the shell — the ONLY wall-clock on the capture path, and a
 * pathological guard: it should never fire once the caller's `quiesce` is a
 * task-quantized, frozen-byte signal (the capture gate in shell-capture.ts).
 * ssr/index.tsx uses it as captureShellHTML's own fallback.
 *
 * 15s, raised from 5s: captures are background work (waitUntil), so the budget
 * costs latency-to-HIT only — never a served response — and 5s spuriously
 * refused legitimately-slow deferred shell material (a real storefront's meta
 * chains settle at ~7s). Ceiling math: workerd's waitUntil lifetime is ~30s
 * past response completion. An attempt that consumed the whole budget is not
 * retried in place (shell-capture.ts CaptureAttemptStats.noShellCause), so
 * the envelope is one budget plus store I/O; the retry follows only an
 * attempt that ended early (a cold-module abort). Past the ceiling the
 * platform kill degrades to the existing best-effort contract (the key stays
 * MISS; a later request re-captures).
 * Node/dev and build-time captures have no waitUntil ceiling. The per-route
 * `ppr.captureTimeout` knob remains for tightening below the default. See
 * docs/design/ppr-shell-resume.md (Cost model).
 */
export const SHELL_CAPTURE_MAX_WAIT_MS = 15_000;

/** Debug/status header on a ppr document response: `HIT` | `MISS`. */
export const SHELL_STATUS_HEADER: string = "x-rango-shell";

/**
 * Partial-navigation replay status header, set only after the captured
 * segment record was consumed (`HIT`) or with the reason it was not.
 */
export const PPR_REPLAY_STATUS_HEADER: string = "x-rango-ppr-replay";

/**
 * Bounded reasons a partial request to a ppr route falls open to the ordinary
 * match (`x-rango-ppr-replay: BYPASS; reason=<reason>`). One list for the
 * producer (rsc-rendering.ts) and the parser (testing/shell-status.ts): a
 * reason the parser does not list parses as null.
 */
export const PPR_REPLAY_BYPASS_REASONS = [
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
  "no-segment-snapshot",
  "snapshot-miss",
  "explicit-cache-hit",
] as const;

/** One of {@link PPR_REPLAY_BYPASS_REASONS}. */
export type PprReplayBypassReason = (typeof PPR_REPLAY_BYPASS_REASONS)[number];

/**
 * The shell key's search portion (`?`-prefixed sorted search with the
 * cache.searchParams filter applied, or "") — ALSO the string the capture and
 * resume SSR renders seed their store location with (SSRRenderOptions.search
 * / ShellCaptureOptions.search / ShellResumeOptions.search). Search is part
 * of shell identity, so static-part `useSearchParams` reads render exactly
 * what the key names; deriving seed and key from this one helper is what
 * keeps capture, resume, and lookup byte-agreed (drift = replay mismatch or
 * permanent MISS).
 */
export function shellSearchSeed(url: URL, filter?: SearchParamsFilter): string {
  const sorted = sortedSearchString(url.searchParams, filter);
  return sorted ? `?${sorted}` : "";
}

/**
 * Shell cache key: router id + host + pathname + sorted search + a `:shell`
 * namespace suffix (so it can never collide with a document-cache key; the
 * store further isolates the shell family internally).
 *
 * The key includes the request HOST: in a multi-tenant host-router deployment
 * (one worker, one shared KV/runtime-cache store) a host-less key would serve
 * tenant A's captured shell to tenant B's users. It starts with the serving
 * ROUTER for the same reason (cache-key-utils.ts, the router rule).
 *
 * `filter` is the request's compiled `cache.searchParams` config
 * (ctx._searchParamsFilter): excluded params collapse onto one shell slot.
 * Callers on the serve/capture path MUST pass it -- key drift between capture
 * and lookup makes every shell request a permanent miss. The testing helper
 * `shellCacheKey` (testing/shell-status.ts) builds its key with it too.
 */
export function buildShellKey(
  routerId: string,
  url: URL,
  filter?: SearchParamsFilter,
): string {
  return `${routerKeyPrefix(routerId)}${url.host}${url.pathname}${shellSearchSeed(url, filter)}:shell`;
}

/**
 * The shell key for one request partition (cache-scope.ts
 * resolveShellPartition): the route cache() `key()` or store keyGenerator
 * result that partitions the route's record partitions its shell too, so
 * each partition captures and serves its own.
 *
 * The partition is URI-encoded: it is request-derived, and raw it could end
 * in a suffix another key is built with (navigationShellKey), so a partition
 * `gold:navigation` named gold's navigation entry and its document shell
 * replayed to gold's navigations. Encoded, it holds no `:` or `|`.
 */
export function partitionShellKey(key: string, partition: string): string {
  return `${key}|${encodeURIComponent(partition)}`;
}

/**
 * The navigation-only entry beside a document shell key (a cold partial
 * request's capture, rsc-rendering.ts). A suffix after the (encoded)
 * partition: partitionShellKey keeps the two unambiguous.
 */
export function navigationShellKey(key: string): string {
  return `${key}:navigation`;
}

/**
 * Fixed number of macrotask hops between `quiesce` resolving and the abort. These
 * give React's fizz worker turns to flush the settled shell into the prelude and
 * mark still-pending boundaries as POSTPONED (rather than errored) before
 * controller.abort() lands. Not a wall-clock wait. Taken by captureShellHTML
 * (ssr/index.tsx) and by the testing SSR stub (testing/serve-shell-request.ts),
 * so the stub freezes the same Flight the real capture would.
 *
 * Why 16 and not 2: the capture's Flight input is the doc record's stored
 * fragments (settleCaptureRecord, shell-capture.ts), already serialized, so the
 * render emits the whole shell payload in the first tick and the gate declares
 * quiesce within a few ms, before fizz has rendered the shell to <body>. When
 * the capture Flight dribbled out as handlers ran, Flight-quiet meant "the shell
 * has rendered" and 2 hops sufficed.
 *
 * Hops alone are NOT render-readiness: fizz cannot emit even <html> until the
 * payload root settles, nor complete a shell whose client components are
 * still loading — real module-runner I/O in dev (100ms+ cold), which no fixed
 * count of near-zero-cost task hops can buy. captureShellHTML therefore
 * awaits the payload-settled signal (SsrRootOptions.onPayloadSettled) and
 * then the client-reference loads in flight in the isolate (captureClientLoads),
 * deadline-bounded, between quiesce and these hops; the hops then only flush
 * the settled tree and mark pending boundaries POSTPONED. Still task-based
 * (masked loaders never emit, so more hops never lets a hole settle). Bounded
 * by maxWaitMs end to end.
 */
export const POST_QUIESCE_TASK_HOPS = 16;

/**
 * Hard cap on one capture TASK — runShellCapture end to end (both attempts +
 * the in-place retry delay). SHELL_CAPTURE_MAX_WAIT_MS arms only inside
 * captureShellHTML, AFTER the capture's router.match(); a handler wedged on a
 * never-settling upstream await (production pilot: a 30s+ tarpitting fetch)
 * wedges the task with no deadline in force. The task's settle path releases
 * the per-key stampede guard and the serialized capture-queue slot, so an
 * unbounded task strands BOTH for the isolate's lifetime.
 *
 * 25s: above one full-budget attempt plus overhead (cutting a second attempt
 * short is an acceptable loss — every terminal path backs the key off anyway),
 * and below workerd's ~30s waitUntil grace so the cap timer still fires in a
 * live context. When workerd kills the context BEFORE the cap fires, the timer
 * dies with it — that stranding is healed by scheduleShellCapture's staleness
 * check on the stampede guard, keyed off the same constant.
 */
export const SHELL_CAPTURE_TASK_HARD_CAP_MS = 25_000;

/**
 * Why a capture attempt refused to store its shell
 * (ShellCaptureDebugEvent.refusal, `caches.refusal` on a `router.prerender()`
 * result): `identity` (a request-scoped read: cookies(), headers(), the
 * theme, a `{ cache: false }` variable), `dynamic` (`ctx.dynamic()`),
 * `loader` (a `{ ssr: false }` loader rejected, or settled with
 * redirect()/notFound()), `no-record` (no doc record: the route's cache()
 * refused the write, or the handler output failed), `handles` (a pushed
 * handle value did not finish encoding), `size` (over the store's value
 * limit), `record-expired` (the route cache() record the capture wrote ran
 * out first), `invalidated` (a tag of the shell was invalidated after the
 * capture started), `uncacheable` (the store cannot hold the entry).
 */
export type ShellCaptureRefusal =
  | "identity"
  | "dynamic"
  | "loader"
  | "no-record"
  | "handles"
  | "size"
  | "record-expired"
  | "invalidated"
  | "uncacheable";

/**
 * Shared PPR loader-lane hint, appended to every capture warning or error
 * whose fix depends on the lane (shell-capture.ts warnings, the cookie-store.ts
 * capture guard). Lives in this import-free leaf so cookie-store.ts can import
 * it without pulling the capture orchestration module. Source anchor for the
 * rule: resolveLoaderData (router/segment-resolution/loader-cache.ts).
 */
export const PPR_LANE_HINT: string =
  "Lane rule: only loader(Def, { ssr: false }) executes at capture and bakes its " +
  "non-promise data; every other loader is live (masked at capture, fresh per " +
  "request) and needs loading() or an inline <Suspense> above its reader. See the " +
  '/ppr skill, "The loader lane rule" (node_modules/@rangojs/router/skills/ppr/SKILL.md).';

/**
 * Once-per-key console warnings of the PPR shell path (the capture, the serve
 * gates, the build-shell read-through), per isolate. One registry, so one
 * reset clears them all ({@link resetShellWarningsForTests}).
 */
const warnedShellKeys = new Set<string>();

function shellWarningId(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

/** Whether {@link warnOnce} already warned for `scope` and `key`. */
export function hasWarnedOnce(scope: string, key: string): boolean {
  return warnedShellKeys.has(shellWarningId(scope, key));
}

/**
 * `console.warn(message())` once per `scope` and `key`; `message` is built only
 * when it prints. Returns true when it warned.
 */
export function warnOnce(
  scope: string,
  key: string,
  message: () => string,
): boolean {
  const id = shellWarningId(scope, key);
  if (warnedShellKeys.has(id)) return false;
  warnedShellKeys.add(id);
  console.warn(message());
  return true;
}

/**
 * @internal Forget every once-per-key shell warning. Tests only: the capture,
 * serve and build-shell resets (testing/serve-shell-request.ts
 * resetShellTestState) call it.
 */
export function resetShellWarningsForTests(): void {
  warnedShellKeys.clear();
}
