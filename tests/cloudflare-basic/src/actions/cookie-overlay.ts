"use server";

import { cookies } from "@rangojs/router";

export async function setCookieAction(): Promise<string> {
  const jar = cookies();
  // Read cookie set by middleware in this same request
  const mwValue = jar.get("mw-overlay")?.value ?? "missing";
  // Set a new cookie that the revalidation loader should see
  jar.set("action-overlay", "from-action", { path: "/" });
  return mwValue;
}

export async function deleteCookieAction(): Promise<void> {
  cookies().delete("to-delete", { path: "/" });
}
