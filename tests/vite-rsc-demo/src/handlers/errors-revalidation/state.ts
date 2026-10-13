import { cookies } from "@rangojs/router";

/**
 * /errors/revalidation keeps its per-browser state in two cookies, so tabs
 * and tests never share it: the stock failure switch (set by
 * setStockRefreshFailure) and the save counter (bumped by saveNote).
 */
const STOCK_FAIL_COOKIE = "rv-demo-fail";
const SAVES_COOKIE = "rv-demo-saves";

export function stockFailing(): boolean {
  return cookies().get(STOCK_FAIL_COOKIE)?.value === "1";
}

export function setStockFailing(failing: boolean): void {
  cookies().set(STOCK_FAIL_COOKIE, failing ? "1" : "0", { path: "/" });
}

export function saves(): number {
  return Number(cookies().get(SAVES_COOKIE)?.value ?? "0");
}

export function bumpSaves(): number {
  const next = saves() + 1;
  cookies().set(SAVES_COOKIE, String(next), { path: "/" });
  return next;
}
