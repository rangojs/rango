import type { Page } from "@playwright/test";

interface FlashProbe {
  flash: boolean;
  detached: boolean;
  obs: MutationObserver;
}

/**
 * Record whether a loading fallback appears (added, or revealed from a hidden
 * Suspense boundary) until readFlash()/readProbe(). A MutationObserver catches
 * even a single-frame skeleton that a plain toBeHidden() would miss.
 * `heldTestIds` additionally records whether any of those elements is
 * detached from the DOM.
 */
export async function watchFlash(
  page: Page,
  fallbackTestId: string,
  heldTestIds: readonly string[] = [],
): Promise<void> {
  await page.evaluate(
    ({ id, held }) => {
      const w = window as unknown as { __flashProbe?: FlashProbe };
      const has = (n: Node, testId: string): boolean =>
        n.nodeType === 1 &&
        ((n as Element).matches?.(`[data-testid="${testId}"]`) ||
          (n as Element).querySelector?.(`[data-testid="${testId}"]`) != null);
      const state = { flash: false, detached: false };
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of Array.from(r.addedNodes)) {
            if (has(n, id)) state.flash = true;
          }
          for (const n of Array.from(r.removedNodes)) {
            if (held.some((h) => has(n, h))) state.detached = true;
          }
          if (
            r.type === "attributes" &&
            has(r.target, id) &&
            getComputedStyle(r.target as Element).display !== "none"
          ) {
            state.flash = true;
          }
        }
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });
      w.__flashProbe = Object.assign(state, { obs });
    },
    { id: fallbackTestId, held: [...heldTestIds] },
  );
}

export async function readProbe(
  page: Page,
): Promise<{ flash: boolean; detached: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as { __flashProbe?: FlashProbe };
    w.__flashProbe?.obs.disconnect();
    return {
      flash: w.__flashProbe?.flash === true,
      detached: w.__flashProbe?.detached === true,
    };
  });
}

export async function readFlash(page: Page): Promise<boolean> {
  return (await readProbe(page)).flash;
}
