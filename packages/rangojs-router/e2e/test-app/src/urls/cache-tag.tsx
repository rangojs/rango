import { urls, updateTag, revalidateTag } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { InvalidateTagButton } from "../components/InvalidateTagButton.js";
import { RevalidateThenReadButton } from "../components/RevalidateThenReadButton.js";
import { LoaderBodyTagDepLoader, LoaderBodyTagLoader } from "../loaders.js";
import {
  controlHeldItem,
  getHeldItem,
  getTaggedCard,
  getTaggedItem,
} from "./cache-tag-data.js";

/**
 * Cache-tag invalidation test fixture (memory store).
 *
 * Every cached source embeds Date.now() so the e2e can tell a cache hit
 * (same ts) from a fresh render (new ts) after invalidation.
 *
 * Covers all three tag axes:
 *   - runtime "use cache" + cacheTag()         -> /item/:id
 *   - cache() DSL with static tags             -> /catalog/:id
 *   - action-driven invalidation via updateTag -> /action-page
 * plus an awaitable invalidation endpoint      -> /invalidate/:tag
 * and, on /action-page, an action that runs revalidateTag() and then reads
 * /item/:id's entry in the same request (#973). /card/:id reads a "use cache"
 * function that calls another, with an action that invalidates the inner
 * tag (#980); /held/:id holds a "use cache" body until /held/:id/release, so
 * another request can invalidate its tag while it runs (#977).
 */

async function LoaderBodyTagPage(ctx: HandlerContext) {
  const data = await ctx.use(LoaderBodyTagLoader);
  return (
    <div data-testid="loader-body-tag-page">
      <span data-testid="lbt-stamp">{data.stamp}</span>
    </div>
  );
}

export const cacheTagPatterns = urls(({ path, cache, loader }) => [
  // Runtime tagging: the response is not cached, but the "use cache" function
  // holds the tagged value, so json.ts is stable until invalidation.
  // path.json serializes the returned value verbatim (no { data } envelope).
  path.json("/item/:id", (ctx) => getTaggedItem(ctx.params.id), {
    name: "cacheTagItem",
  }),

  // DSL tagging: cache() with static tags caches + tags the response itself.
  cache({ ttl: 600, tags: ["catalog"] }, () => [
    path.json(
      "/catalog/:id",
      (ctx) => ({ ts: Date.now(), id: ctx.params.id }),
      { name: "cacheTagCatalog" },
    ),
  ]),

  // Awaitable invalidation endpoint (webhook/route-handler style). updateTag
  // resolves once invalidation has landed, so the next read is deterministically
  // fresh - no polling needed.
  // Test fixture only: the tag comes from the URL param so the e2e can exercise
  // arbitrary tags. Never do this in production code - deriving invalidation tags
  // from untrusted input lets an attacker grow the tag-marker namespace without
  // bound (see CFCacheStoreOptions.tagInvalidationTtl).
  path.json(
    "/invalidate/:tag",
    async (ctx) => {
      await updateTag(ctx.params.tag);
      return { ok: true, tag: ctx.params.tag };
    },
    { name: "cacheTagInvalidate" },
  ),

  // Background invalidation endpoint. revalidateTag is fire-and-forget via
  // waitUntil, so the response returns BEFORE invalidation lands - the e2e polls
  // for freshness rather than awaiting (unlike updateTag above).
  // Test fixture only: the tag comes from the URL param so the e2e can exercise
  // arbitrary tags. Never do this in production code - deriving invalidation tags
  // from untrusted input lets an attacker grow the tag-marker namespace without
  // bound (see CFCacheStoreOptions.tagInvalidationTtl).
  path.json(
    "/revalidate/:tag",
    (ctx) => {
      revalidateTag(ctx.params.tag);
      return { ok: true, tag: ctx.params.tag };
    },
    { name: "cacheTagRevalidate" },
  ),

  // A loader with its own cache() and no cache({ tags }): the tags its body
  // and its dependency record are the entry's only tags (#964). The
  // dependency is bound after it, so the DSL starts it, not the body.
  path(
    "/loader-body",
    LoaderBodyTagPage,
    { name: "cacheTagLoaderBody" },
    () => [
      loader(LoaderBodyTagLoader, () => [cache({ ttl: 600 })]),
      loader(LoaderBodyTagDepLoader),
    ],
  ),

  // A "use cache" function whose only tag comes from the "use cache"
  // function it calls, and a button whose action runs updateTag() on it.
  path(
    "/card/:id",
    async (ctx) => {
      const card = await getTaggedCard(ctx.params.id);
      return (
        <div data-testid="nested-card-page">
          <span data-testid="nested-card-ts">{card.ts}</span>
          <span data-testid="nested-card-stock-ts">{card.stockTs}</span>
          <InvalidateTagButton tag={`nested-stock:${ctx.params.id}`} />
        </div>
      );
    },
    { name: "cacheTagNestedCard" },
  ),

  // A "use cache" body held after it read its data (#977), and its controls:
  // hold | started | mutate (new data + updateTag) | release.
  path.json("/held/:id", (ctx) => getHeldItem(ctx.params.id), {
    name: "cacheTagHeld",
  }),
  path.json(
    "/held/:id/:op",
    async (ctx) => {
      const result = controlHeldItem(ctx.params.id, ctx.params.op);
      if (ctx.params.op === "mutate") await updateTag(`held:${ctx.params.id}`);
      return result ?? { ok: true };
    },
    { name: "cacheTagHeldControl" },
  ),

  // Action-driven invalidation: a cached, tagged page segment plus a client
  // button whose server action calls updateTag("action-tag").
  cache({ ttl: 600, tags: ["action-tag"] }, () => [
    path(
      "/action-page",
      () => (
        <div data-testid="action-tag-page">
          <span data-testid="action-tag-ts">{Date.now()}</span>
          <InvalidateTagButton tag="action-tag" />
          <RevalidateThenReadButton />
        </div>
      ),
      { name: "cacheTagActionPage" },
    ),
  ]),
]);
