import { type Page } from "@playwright/test";
import { testId } from "./helper";

// Accessors and readers for the shared CachedInlineActionForm fixture, used by
// both the use-cache and prerender/static inline-action e2e suites.
export const inlineAction = {
  page: (page: Page) => testId(page, "cached-inline-action-page"),
  rendered: (page: Page) => testId(page, "cached-inline-rendered-token"),
  submit: (page: Page) => testId(page, "cached-inline-action-submit"),
  captured: (page: Page) => testId(page, "cached-inline-captured-token"),
  asyncValue: (page: Page) => testId(page, "cached-inline-async-value"),
  session: (page: Page) => testId(page, "cached-inline-session-cookie"),
};

export const readRendered = async (page: Page) =>
  (await inlineAction.rendered(page).textContent())!.replace(/^rendered:/, "");

export const readAsync = async (page: Page) =>
  (await inlineAction.asyncValue(page).textContent())!.replace(/^async:/, "");

// The cookie the action body reads via cookies() to prove live request scope.
// Same name each call -> overwrites, so each submit observes a distinct value.
export function setSession(page: Page, url: string, value: string) {
  return page.context().addCookies([{ name: "cai-session", value, url }]);
}
