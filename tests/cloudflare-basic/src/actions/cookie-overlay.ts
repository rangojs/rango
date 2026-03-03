"use server";

import { getRequestContext } from "@rangojs/router";

export async function setCookieAction(): Promise<string> {
  const ctx = getRequestContext();
  // Read cookie set by middleware in this same request
  const mwValue = ctx.cookie("mw-overlay") ?? "missing";
  // Set a new cookie that the revalidation loader should see
  ctx.setCookie("action-overlay", "from-action", { path: "/" });
  return mwValue;
}

export async function deleteCookieAction(): Promise<void> {
  const ctx = getRequestContext();
  ctx.deleteCookie("to-delete", { path: "/" });
}
