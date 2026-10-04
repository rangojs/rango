"use server";

// Issue #973 fixture: a server action that calls revalidateTag() (not
// awaited) and then reads a "use cache" entry carrying that tag in the same
// request. The value it returns must be fresh: the store masks the tag for
// the request before revalidateTag() returns.
// Test-fixture pattern (like /cache-tag-test/revalidate/:tag): the tag comes
// from the form; never take invalidation tags from untrusted input in an app.

import { revalidateTag } from "@rangojs/router";
import { getTaggedItem } from "../urls/cache-tag-data.js";

export async function revalidateThenReadAction(
  _prev: { id: string; ts: number } | null,
  formData: FormData,
): Promise<{ id: string; ts: number }> {
  const id = String(formData.get("id") ?? "");
  revalidateTag(`item:${id}`);
  const item = await getTaggedItem(id);
  return { id, ts: item.ts };
}
