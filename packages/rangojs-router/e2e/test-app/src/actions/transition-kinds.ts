"use server";

/**
 * /vt-kinds/*: an action that changes nothing. Its revalidation re-renders
 * the page, whose stamp changes, so the probe <ViewTransition> sees the
 * action's commit.
 */
export async function transitionKindsAction(count: number): Promise<number> {
  return count + 1;
}
