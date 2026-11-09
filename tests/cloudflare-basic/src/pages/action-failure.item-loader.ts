import { createLoader, notFound, redirect } from "@rangojs/router";
import {
  isActionFailureItemArchived,
  isActionFailureItemDeleted,
} from "./action-failure.items.js";

/**
 * An item. Once a delete action removed it, its rerun throws redirect() to
 * the list, as a deleted record's page does (e2e/action-failure.test.ts).
 */
export const ActionFailureItemLoader = createLoader(
  async (ctx): Promise<{ name: string }> => {
    const run = ctx.searchParams.get("run") ?? "none";
    if (isActionFailureItemDeleted(run, ctx.params.id ?? "")) {
      throw redirect(`/action-failure-server/items?run=${run}`);
    }
    if (isActionFailureItemArchived(run, ctx.params.id ?? "")) {
      throw notFound(`item ${ctx.params.id} is archived`);
    }
    return { name: `item ${ctx.params.id}` };
  },
);
