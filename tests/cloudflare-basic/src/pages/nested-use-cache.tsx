import type { HandlerContext } from "@rangojs/router";
import { invalidateNestedStock } from "../actions/nested-use-cache.js";
import { getNestedCard } from "../use-cache-tags-data.js";

/**
 * Issue #980 fixture (urls.tsx /nested-use-cache/:probe): a "use cache"
 * function whose only tag comes from the "use cache" function it calls, and
 * a form whose server action runs updateTag() on that tag.
 * `nested-card-stock` repeats on a HIT of the outer entry.
 */
export async function NestedUseCachePage(
  ctx: HandlerContext<{ probe: string }>,
) {
  const card = await getNestedCard(ctx.params.probe);
  return (
    <main data-testid="nested-use-cache">
      <p data-testid="nested-card-stock">{card.stock}</p>
      <form action={invalidateNestedStock}>
        <input type="hidden" name="probe" value={ctx.params.probe} />
        <button type="submit" data-testid="nested-invalidate">
          updateTag
        </button>
      </form>
    </main>
  );
}
