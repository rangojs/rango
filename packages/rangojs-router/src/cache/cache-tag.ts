/**
 * Cache Tag API
 *
 * Provides cacheTag() for tagging cached entries at runtime inside "use cache"
 * functions. Tags are scoped via AsyncLocalStorage; calling cacheTag() outside
 * a "use cache" execution throws.
 *
 * The runtime (cache-runtime.ts) wraps "use cache" execution in
 * runWithCacheTagScope(), collects the runtime tags, and merges them with the
 * profile/DSL tags before storing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  _getRequestContext,
  type RequestContext,
} from "../server/request-context.js";

const cacheTagStorage = new AsyncLocalStorage<Set<string>>();

export function normalizeTag(tag: string): string | null {
  // Trim and return the canonical (trimmed) form, not the raw tag. Both the
  // write path (cacheTag) and the invalidate path (updateTag/revalidateTag)
  // route through here, and matching is exact-string: returning the untrimmed
  // tag made cacheTag(" products ") and updateTag("products") two different
  // logical tags, a silent failure-to-invalidate (stale data served forever).
  const trimmed = tag?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeTags(tags: Iterable<string>): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

/**
 * Tag content for later invalidation via updateTag() / revalidateTag().
 *
 * cacheTag() serves two forms depending on what is active when it runs:
 *
 * 1. Inside a "use cache" function — the DEFAULT. The tags go to the current
 *    cache entry; `revalidateTag(tag)` drops that entry. Tags are additive
 *    (multiple calls accumulate), and normalizeTag() is the single chokepoint so
 *    a padded write matches an unpadded invalidate.
 *
 * 2. Render-callable (#648) — no "use cache" scope active, but a request context
 *    is present. The tags record onto the request's DOCUMENT artifact
 *    (ctx._requestTags) instead of throwing. The collection layers already exist:
 *    PPR shell capture unions _requestTags into the shell entry, the document
 *    cache tags the full-page entry with it, and prerender build contexts seed
 *    their own set — so a server component that renders into a shell makes
 *    `revalidateTag("campaign:spring")` evict that shell with ZERO cache()/"use
 *    cache" in its tree. This is PPR's DERIVATIVE invalidation: PPR is
 *    execution-PRESERVING (everything still runs underneath; only document bytes
 *    are shortcut), so its tags ride this existing instrument rather than a
 *    first-class ppr key/tag API. The shell-expiry invariant holds by
 *    construction — baked ⇒ evicts (bake-lane loaders execute during capture and
 *    record here), hole ⇒ fresh (masked loaders behind a renderable loading()
 *    never execute during capture, so nothing under a hole can tag the shell).
 *
 * Inside a cache() DSL segment the render-callable form records at the DOCUMENT
 * level, not the segment (only the "use cache" runtime enters the tag scope) — a
 * documented semantic, not a filtered one. An empty/whitespace-only tag is
 * dropped in both forms (the render-callable form silently, via normalizeTags in
 * recordRequestTags; the scope form with a dev warning).
 *
 * With neither a scope nor a request context, cacheTag() throws.
 *
 * @example
 * ```typescript
 * // Form 1 — inside "use cache":
 * async function getProduct(ctx) {
 *   "use cache";
 *   cacheTag(`product:${ctx.params.id}`, "products");
 *   return db.getProduct(ctx.params.id);
 * }
 *
 * // Form 2 — render-callable, tags the shell/document from a server component:
 * function CampaignBanner() {
 *   cacheTag("campaign:spring");
 *   return <aside>Spring sale</aside>;
 * }
 * ```
 */
export function cacheTag(...tags: string[]): void {
  const store = cacheTagStorage.getStore();
  if (store) {
    // Form 1: "use cache" scope wins — tag the cache entry (unchanged).
    for (const tag of tags) {
      const normalized = normalizeTag(tag);
      if (normalized === null) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[cacheTag] Ignoring empty or whitespace-only tag.`);
        }
        continue;
      }
      store.add(normalized);
    }
    return;
  }

  const reqCtx = _getRequestContext();
  if (reqCtx?._requestTags) {
    // Form 2: render-callable — tag the request's document artifact. See the
    // JSDoc above for the composition doctrine and the baked/hole invariant.
    recordRequestTags(tags, reqCtx);
    return;
  }

  throw new Error(
    'cacheTag() must be called inside a "use cache" function or during a request render.',
  );
}

export function recordRequestTags(
  tags: Iterable<string> | undefined,
  ctx: RequestContext | undefined = _getRequestContext(),
): void {
  if (!tags) return;
  const set = ctx?._requestTags;
  if (!set) return;
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized !== null) set.add(normalized);
  }
}

/**
 * Run a function within a cache tag scope. Any cacheTag() calls inside `fn`
 * accumulate into the returned Set.
 *
 * The returned Set is the LIVE reference - the caller must await `result`
 * before reading `tags`, because an async cached function may call cacheTag()
 * after an await boundary.
 *
 * @internal Used by cache-runtime.ts to wrap "use cache" execution.
 */
export function runWithCacheTagScope<T>(fn: () => T): {
  result: T;
  tags: Set<string>;
} {
  const tagSet = new Set<string>();
  const result = cacheTagStorage.run(tagSet, fn);
  return { result, tags: tagSet };
}
