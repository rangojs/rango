import { expect, test, type Page } from "@playwright/test";

export interface FirstFrameRecord {
  clickAt: number;
  /** The first DOM batch after the click that matches a `frame` selector. */
  frameAt: number;
  /** The text of the `textAt` selector in that batch. */
  textAtFrame: string | null;
  /** The first DOM batch that matches `canonical`. */
  canonicalAt: number;
}

/**
 * Time, in the page, from the click on `link` to the first DOM batch that
 * matches one of the `frame` selectors, and to the first that matches
 * `canonical`. The text of `textAt` in that first batch is recorded too.
 */
export async function recordFirstFrame(
  page: Page,
  link: string,
  frame: readonly string[],
  canonical: string,
  textAt?: string,
): Promise<FirstFrameRecord> {
  await page.evaluate(
    ({ frame, canonical, textAt }) => {
      const w = window as unknown as { __firstFrame?: FirstFrameRecord };
      const has = (selector: string) =>
        document.querySelector(selector) !== null;
      const record: FirstFrameRecord = {
        clickAt: 0,
        frameAt: 0,
        textAtFrame: null,
        canonicalAt: 0,
      };
      w.__firstFrame = record;
      document.addEventListener(
        "click",
        () => {
          record.clickAt = performance.now();
        },
        { capture: true, once: true },
      );
      const observer = new MutationObserver(() => {
        if (record.clickAt === 0) return;
        if (record.frameAt === 0 && frame.some(has)) {
          record.frameAt = performance.now();
          record.textAtFrame = textAt
            ? (document.querySelector(textAt)?.textContent ?? null)
            : null;
        }
        if (has(canonical)) {
          record.canonicalAt = performance.now();
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-pending"],
      });
    },
    { frame: [...frame], canonical, textAt },
  );
  await page.getByTestId(link).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __firstFrame: FirstFrameRecord }).__firstFrame
            .canonicalAt,
      ),
    )
    .toBeGreaterThan(0);
  const record = await page.evaluate(
    () =>
      (window as unknown as { __firstFrame: FirstFrameRecord }).__firstFrame,
  );
  test.info().annotations.push({
    type: "timing",
    description: `${link}: first frame ${Math.round(record.frameAt - record.clickAt)} ms, canonical ${Math.round(record.canonicalAt - record.clickAt)} ms after the click`,
  });
  return record;
}
