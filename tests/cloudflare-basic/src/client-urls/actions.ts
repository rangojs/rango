"use server";

export async function clientUrlsTargetAction(): Promise<void> {}

export async function clientUrlsDecoyAction(): Promise<void> {}

/**
 * Its result decides ClientUrlsResultLoader's revalidate() on the server
 * (urls.tsx). In this module, so the namespace-gated loader re-runs on it
 * too: that re-run marks the action's commit.
 */
export async function clientUrlsResultAction(
  ok: boolean,
): Promise<{ ok: boolean }> {
  return { ok };
}
