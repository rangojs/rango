import type { RevalidateParams } from "@rangojs/router";
import { clientUrlsResultAction } from "./actions.js";

/**
 * ClientUrlsResultLoader's revalidate() (urls.tsx): re-run after
 * clientUrlsResultAction succeeds, hold after it fails, defer otherwise. It
 * runs on the server, where the action's result exists; a module without
 * "use client", so the unit suite tests it with runRevalidate.
 */
export function onResultOk({
  isAction,
  actionResult,
}: RevalidateParams): boolean | undefined {
  return isAction(clientUrlsResultAction)
    ? actionResult?.ok === true
    : undefined;
}
