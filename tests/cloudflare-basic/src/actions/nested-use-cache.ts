"use server";

// Issue #980 fixture: updateTag() of the tag only the inner "use cache"
// function of /nested-use-cache/:probe records. The action's revalidation
// render re-reads the outer function, whose entry must be gone too.
// Test-fixture pattern (like /test/invalidate-tag): the probe comes from the
// form; never take invalidation tags from untrusted input in an app.

import { updateTag } from "@rangojs/router";
import { nestedTag } from "../use-cache-tags-data.js";

export async function invalidateNestedStock(formData: FormData): Promise<void> {
  await updateTag(nestedTag(String(formData.get("probe") ?? "none")));
}
