"use server";

import { bumpClientUrlsActionCount } from "./client-urls-action.store.js";

/**
 * Actions whose outcome and form data decide a clientUrls() group loader's
 * revalidate() on the server (client-urls-action.tsx): the predicates read
 * `actionResult` and `formData`, which only the server has. Both bump the
 * shared counter, so the counter loader's re-run marks the action's commit.
 */
export async function clientUrlsResultAction(
  ok: boolean,
): Promise<{ ok: boolean }> {
  bumpClientUrlsActionCount();
  return { ok };
}

export async function clientUrlsScopeAction(formData: FormData): Promise<void> {
  void formData;
  bumpClientUrlsActionCount();
}
