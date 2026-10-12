"use server";

import { setActionFailure } from "./action-failure.defs.js";
import { deleteActionFailureItem } from "./action-failure.items.js";

// Both succeed; the page's loaders rerun after them and fail while the run's
// switch is on.
export async function actionFailureSwitch(
  run: string,
  fail: boolean | "always",
): Promise<{ saved: string }> {
  setActionFailure(run, fail);
  return { saved: fail ? "failing" : "recovered" };
}

// Answers after a sibling called with it: the sibling's answer lands while
// this one is still fetching, and this one refetches for both.
export async function actionFailureSlow(): Promise<{ saved: string }> {
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { saved: "slow" };
}

export async function actionFailureSwitchForm(
  formData: FormData,
): Promise<void> {
  setActionFailure(
    String(formData.get("run")),
    formData.get("fail") === "true",
  );
}

// Deletes an item; the item page's loader then redirects to the list.
export async function actionFailureDeleteItem(
  run: string,
  id: string,
): Promise<{ deleted: string }> {
  deleteActionFailureItem(run, id);
  return { deleted: id };
}
