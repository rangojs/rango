"use server";

import { getRequestContext } from "@rangojs/router";
import type { AppBindings } from "../env.js";

export interface GuidePlainActionState {
  status: string;
}

// Server action on the plain onDemand route (/guide-plain/:slug). The action
// re-render must serve the KV overlay: an overlay-only slug has no live
// handler and no baked entry. With refresh=1 it calls router.prerender() first,
// so the re-render must carry the entry the action just stored.
export async function guidePlainAction(
  _prev: GuidePlainActionState | null,
  formData: FormData,
): Promise<GuidePlainActionState> {
  const slug = String(formData.get("slug"));
  if (formData.get("refresh") !== "1") return { status: `noop:${slug}` };
  const { router } = await import("../router.js");
  const result = await router.prerender(
    { route: "guidePlain", params: { slug } },
    { env: getRequestContext().env as AppBindings },
  );
  return { status: `${result.status}:${slug}` };
}
