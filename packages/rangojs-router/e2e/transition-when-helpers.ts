import { expect, type Page } from "@playwright/test";
import { testId } from "./helper";

/**
 * Helpers for the transition({ when }) suites. The test-app predicates
 * (test-app/src/components/transition-when.ts) log every call to
 * window.__txWhenLog; TxMountProbe counts mounts in window.__txMounts and
 * shows `clicks:N`, so a reconcile keeps N and a remount resets it.
 */

export interface TxWhenLogEntry {
  name?: string;
  kind: string;
  from: string;
  to: string;
  sameLocation?: boolean;
  fromParams: Record<string, string>;
  toParams: Record<string, string>;
  fromRouteName?: string;
  toRouteName?: string;
  toAnimate?: boolean;
  isAction?: boolean;
  actionResult?: unknown;
  actionError?: boolean;
  actionFormData?: boolean;
  result: boolean;
}

export async function whenLog(
  page: Page,
  key: "__txWhenLog" | "__ctWhenLog" = "__txWhenLog",
): Promise<TxWhenLogEntry[]> {
  return page.evaluate(
    (k) => (window as unknown as Record<string, TxWhenLogEntry[]>)[k] ?? [],
    key,
  );
}

export async function mounts(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __txMounts?: number }).__txMounts ?? 0,
  );
}

export async function clicks(page: Page): Promise<string> {
  return (await testId(page, "tx-probe").last().textContent()) ?? "";
}

export async function bump(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await testId(page, "tx-probe").last().click();
}

// The flash probe lives in @shared/e2e so the held-boundary scenario shares it.
export { readFlash, watchFlash } from "@shared/e2e";

/** Click a /tx-src link and wait for the destination's :n to render. */
export async function goTxSrc(
  page: Page,
  linkId: string,
  n: string,
): Promise<void> {
  await testId(page, linkId).last().click();
  await expect(testId(page, "tx-src-n").last()).toHaveText(n, {
    timeout: 8000,
  });
  // Let a held commit and its view transition settle before the next step.
  await page.waitForTimeout(600);
}
