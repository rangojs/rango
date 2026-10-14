import type { Page } from "@playwright/test";

/**
 * Count document.startViewTransition calls per document: call before
 * page.goto, read with viewTransitions(). Counts view transitions, not
 * milliseconds; a gated-off commit starts none. viewTransitionTypes() reads
 * the transition types React passed to each call.
 */
export async function countViewTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __vtCount?: number;
      __vtTypes?: string[][];
    };
    w.__vtCount = 0;
    w.__vtTypes = [];
    const original = document.startViewTransition?.bind(document);
    if (!original) return;
    document.startViewTransition = ((arg: unknown) => {
      w.__vtCount = (w.__vtCount ?? 0) + 1;
      const types = (arg as { types?: Iterable<string> } | undefined)?.types;
      (w.__vtTypes ??= []).push(types ? [...types] : []);
      return original(arg as never);
    }) as typeof document.startViewTransition;
  });
}

export async function viewTransitions(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __vtCount?: number }).__vtCount ?? 0,
  );
}

export async function viewTransitionTypes(page: Page): Promise<string[][]> {
  return page.evaluate(
    () => (window as unknown as { __vtTypes?: string[][] }).__vtTypes ?? [],
  );
}
