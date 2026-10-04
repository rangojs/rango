import type { HandlerContext } from "@rangojs/router";
import { revalidateRyow } from "../actions/ryow.js";
import { RyowLoader } from "../loaders/ryow.js";

/**
 * Issue #973 fixture (urls.tsx /ryow-action/:probe): a loader cached on the
 * slow-marker store, and a form whose server action runs revalidateTag() on
 * its tag. `ryow-loaded-at` repeats on a loader-cache HIT.
 */
export async function RyowActionPage(ctx: HandlerContext<{ probe: string }>) {
  const { loadedAt } = await ctx.use(RyowLoader);
  return (
    <main data-testid="ryow-action">
      <p data-testid="ryow-loaded-at">{loadedAt}</p>
      <form action={revalidateRyow}>
        <input type="hidden" name="probe" value={ctx.params.probe} />
        <button type="submit" data-testid="ryow-revalidate">
          revalidateTag
        </button>
      </form>
    </main>
  );
}
