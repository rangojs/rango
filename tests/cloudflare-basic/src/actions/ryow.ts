"use server";

// Issue #973 fixture: a server action that calls revalidateTag() (not
// awaited) on the /ryow-action loader's tag. Its revalidation render re-runs
// the loader through its cache() while the KV marker write is still held
// (slow-marker-store.ts), so the render is fresh only if the store masked
// the tag for the request before revalidateTag() returned.
// Test-fixture pattern (like /test/revalidate-tag): the tag comes from the
// form; never take invalidation tags from untrusted input in an app.

import { revalidateTag } from "@rangojs/router";
import { ryowTag } from "../loaders/ryow.js";

export async function revalidateRyow(formData: FormData): Promise<void> {
  revalidateTag(ryowTag(String(formData.get("probe") ?? "none")));
}
