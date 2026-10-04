"use server";

// Test fixture (issue #941): a server action that invalidates the
// /ppr-fresh-reads shell's tag. Its response carries the fresh-reads cookie,
// so the same user's next requests read past the stores' isolate memos.
// Test-fixture pattern (like /test/invalidate-tag): the tag comes from the
// page's probe; never take invalidation tags from untrusted input in an app.

import { updateTag } from "@rangojs/router";
import { freshReadsTag } from "../pages/ppr-fresh-reads-tag.js";

export async function invalidateFreshReadsShell(
  probe: string,
): Promise<{ ok: true }> {
  await updateTag(freshReadsTag(probe));
  return { ok: true };
}
