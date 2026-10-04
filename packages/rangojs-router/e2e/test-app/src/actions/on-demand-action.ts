"use server";

import { getRequestContext } from "@rangojs/router";
import type { AppEnv } from "../router.js";

export interface OnDemandActionState {
  status: string;
}

// Server action on the plain onDemand route (/on-demand-plain/:slug). The
// action re-render must serve the overlay: an overlay-only slug has no live
// handler and no baked entry. With refresh=1 it calls router.prerender() first,
// so the re-render must carry the entry the action just stored.
export async function onDemandPlainAction(
  _prev: OnDemandActionState | null,
  formData: FormData,
): Promise<OnDemandActionState> {
  const slug = String(formData.get("slug"));
  if (formData.get("refresh") !== "1") return { status: `noop:${slug}` };
  const { router } = await import("../router.js");
  const result = await router.prerender(`/on-demand-plain/${slug}`, {
    env: getRequestContext().env as AppEnv,
  });
  return { status: `${result.status}:${slug}` };
}
