/**
 * Cache Tag Invalidation API
 *
 * Two on-demand invalidation verbs, mirroring the distinction popularized by
 * Next.js so consumers can pick the right consistency model:
 *
 * - updateTag(...tags): read-your-own-writes. Awaitable - resolves only after
 *   in-process invalidation across every configured store completes. Use in a
 *   Server Action and `await` it before the action re-renders, so the action's
 *   own response reflects the mutation.
 *
 * - revalidateTag(...tags): fire-and-forget via waitUntil - the response is not
 *   blocked. Use in Route Handlers / webhooks. NOTE: both verbs hard-purge; the
 *   only difference is awaitability. revalidateTag does NOT serve stale content -
 *   the next read after the invalidation lands is a hard miss that re-renders.
 *   (The name mirrors Next.js, where it is SWR; here it is background-purge.)
 *
 * Both fan out across the app-level store (ctx._cacheStore) and every explicit
 * per-scope store from cache({ store }) registered for this handler
 * (ctx._explicitTaggedStores), calling the store-level invalidateTags()
 * primitive for each tag. A single configured store (the common case) owns its
 * own tag index and distributed invalidation - there is no separate
 * tag-invalidation store.
 */

import { _getRequestContext } from "../server/request-context.js";
import { reportingAsync } from "./cache-error.js";
import { normalizeTags } from "./cache-tag.js";
import type { SegmentCacheStore } from "./types.js";

/**
 * Collect every store that may hold entries tagged for this request's handler:
 * the app-level store plus all explicit per-scope stores (deduplicated). Splits
 * them into tag-capable (implement invalidateTags()) and not, so callers can
 * warn about configured stores whose tagged entries will NOT be invalidated.
 *
 * `hasContext` reports whether an ALS request context existed at all. Without one
 * (e.g. a queue consumer or cron job calling updateTag/revalidateTag) no stores
 * are reachable, and the empty-capable case is a missing-context problem, not a
 * store-config problem - callers branch on this to warn about the right cause.
 */
function collectStores(): {
  capable: SegmentCacheStore[];
  incapable: number;
  hasContext: boolean;
} {
  const ctx = _getRequestContext();
  const stores = new Set<SegmentCacheStore>();
  if (ctx?._cacheStore) stores.add(ctx._cacheStore);
  if (ctx?._explicitTaggedStores) {
    for (const store of ctx._explicitTaggedStores) stores.add(store);
  }
  const capable: SegmentCacheStore[] = [];
  let incapable = 0;
  for (const store of stores) {
    if (typeof store.invalidateTags === "function") capable.push(store);
    else incapable++;
  }
  return { capable, incapable, hasContext: ctx != null };
}

/**
 * Production-visible warning. A misconfigured store silently dropping
 * invalidations is a data-correctness footgun, so this surfaces in every
 * environment (not dev-only).
 */
function warnNoTagStore(fn: string, tags: string[]): void {
  console.warn(
    `[${fn}] No tag-capable cache store is configured; tags ` +
      `[${tags.join(", ")}] were not invalidated. The configured store must ` +
      `implement invalidateTags() (the built-in MemorySegmentCacheStore and ` +
      `CFCacheStore do).`,
  );
}

/**
 * Production-visible warning for the no-request-context case. Distinct from
 * warnNoTagStore: the stores are not unreachable because they are misconfigured,
 * but because there is no ALS request context to reach them through (e.g. a queue
 * consumer or scheduled job). Naming the real cause keeps consumers from chasing
 * a store-config red herring.
 */
function warnNoRequestContext(fn: string, tags: string[]): void {
  console.warn(
    `[${fn}] Called outside a request context (e.g. from a queue consumer or ` +
      `scheduled job); no cache stores are reachable and tags ` +
      `[${tags.join(", ")}] were not invalidated. Invoke it within a request ` +
      `(Server Action or route handler).`,
  );
}

/**
 * Production-visible warning for mixed-store configs: at least one configured
 * store does not support tag invalidation, so its tagged entries (if any) are
 * left stale even though other stores were invalidated.
 */
function warnPartialTagStore(fn: string, incapable: number): void {
  console.warn(
    `[${fn}] ${incapable} configured cache store(s) do not implement ` +
      `invalidateTags(); their tagged entries were NOT invalidated. Use a ` +
      `tag-capable store (e.g. MemorySegmentCacheStore / CFCacheStore) for any ` +
      `cache({ store }) boundary whose entries you invalidate by tag.`,
  );
}

async function invalidateAcross(
  stores: SegmentCacheStore[],
  tags: string[],
): Promise<void> {
  // One invalidateTags(tags) call per store: the store receives the whole tag
  // batch so it can do a single CDN purge request rather than one per tag.
  //
  // allSettled, not all: a store's invalidateTags() can reject (e.g. CFCacheStore
  // surfaces a failed durable KV marker write). With Promise.all, the first
  // rejection would short-circuit and the other stores' outcomes would go
  // unobserved. Attempt every store, then surface a combined error so an awaited
  // updateTag() still rejects (read-your-own-writes honesty) without masking the
  // stores that did succeed.
  const results = await Promise.allSettled(
    stores.map((store) => store.invalidateTags!(tags)),
  );
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  if (errors.length > 0) {
    const err = new Error(
      `[tag invalidation] ${errors.length}/${stores.length} store(s) failed to ` +
        `invalidate tags [${tags.join(", ")}]; their entries may still serve ` +
        `stale data. Retry the invalidation.`,
    );
    (err as Error & { cause?: unknown }).cause = errors[0];
    throw err;
  }
}

/**
 * Immediately expire every cache entry tagged with any of `tags`, resolving
 * once in-process invalidation across all configured stores completes.
 *
 * Read-your-own-writes: because the returned promise resolves before you return
 * from a Server Action, awaiting it guarantees the action's own re-render (and
 * any subsequent read) sees fresh data.
 *
 * @example
 * ```typescript
 * async function updateProduct(formData: FormData) {
 *   "use server";
 *   await db.updateProduct(formData);
 *   await updateTag("products");   // next render is fresh
 * }
 * ```
 */
export async function updateTag(...tags: string[]): Promise<void> {
  const valid = normalizeTags(tags);
  if (valid.length === 0) return;

  const { capable, incapable, hasContext } = collectStores();
  if (capable.length === 0) {
    if (hasContext) warnNoTagStore("updateTag", valid);
    else warnNoRequestContext("updateTag", valid);
    return;
  }
  if (incapable > 0) warnPartialTagStore("updateTag", incapable);

  await invalidateAcross(capable, valid);
}

/**
 * Invalidate every cache entry tagged with any of `tags` in the background,
 * without blocking the current response (fire-and-forget via waitUntil).
 *
 * This is NOT stale-while-revalidate: like updateTag() it hard-purges, so the
 * next read after the invalidation lands is a miss that re-renders fresh. The
 * only difference from updateTag() is awaitability - revalidateTag() defers the
 * purge off the response path and is not awaited.
 *
 * Use in Route Handlers / webhooks. For read-your-own-writes inside a Server
 * Action, use updateTag() instead so the action's own response is fresh.
 *
 * Fire-and-forget: because this returns void and runs in the background, a
 * failed durable marker write (e.g. a transient KV outage) is NOT surfaced to
 * the caller. It IS reported - logged loudly and routed through the router's
 * `onError` callback (phase `cache`, `metadata.category === "cache-invalidate"`)
 * via reportingAsync - so the failure is observable in telemetry even though it
 * cannot be awaited. If you need the invalidation to be CONFIRMED (and to retry
 * on failure), use `await updateTag()` instead, which rejects when a store's
 * durable write fails.
 *
 * @example
 * ```typescript
 * // route handler invoked by an external webhook
 * export async function POST() {
 *   "use server";
 *   revalidateTag("products");
 *   return new Response("ok");
 * }
 * ```
 */
export function revalidateTag(...tags: string[]): void {
  const valid = normalizeTags(tags);
  if (valid.length === 0) return;

  const { capable, incapable, hasContext } = collectStores();
  if (capable.length === 0) {
    if (hasContext) warnNoTagStore("revalidateTag", valid);
    else warnNoRequestContext("revalidateTag", valid);
    return;
  }
  if (incapable > 0) warnPartialTagStore("revalidateTag", incapable);

  const ctx = _getRequestContext();
  // reportingAsync never rejects: it catches a failed durable write and routes
  // it through reportCacheError (loud log + onError). This is the only place a
  // revalidateTag failure can be observed, since it is not awaitable. Pass ctx
  // explicitly - the run executes in a detached waitUntil where the ALS context
  // is gone, so onError fires only if we hand it the captured context.
  const run = () =>
    reportingAsync(
      () => invalidateAcross(capable, valid),
      "cache-invalidate",
      "[revalidateTag] background invalidation",
      ctx,
    );
  if (ctx?.waitUntil) {
    ctx.waitUntil(run);
  } else {
    // No request context (e.g. called outside ALS): best-effort background run.
    void run();
  }
}
