import type { Page } from "@playwright/test";

/**
 * Count document.startViewTransition calls per document: call before
 * page.goto, read with viewTransitions(). Counts view transitions, not
 * milliseconds; a gated-off commit starts none.
 */
export async function countViewTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __vtCount?: number };
    w.__vtCount = 0;
    const original = document.startViewTransition?.bind(document);
    if (!original) return;
    document.startViewTransition = ((arg: unknown) => {
      w.__vtCount = (w.__vtCount ?? 0) + 1;
      return original(arg as never);
    }) as typeof document.startViewTransition;
  });
}

export async function viewTransitions(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __vtCount?: number }).__vtCount ?? 0,
  );
}
