"use server";

import { setActionFailure } from "./action-failure.defs.js";

// Both succeed; the page's loaders rerun after them and fail while the run's
// switch is on.
export async function actionFailureSwitch(
  run: string,
  fail: boolean,
): Promise<{ saved: string }> {
  setActionFailure(run, fail);
  return { saved: fail ? "failing" : "recovered" };
}

export async function actionFailureSwitchForm(
  formData: FormData,
): Promise<void> {
  setActionFailure(
    String(formData.get("run")),
    formData.get("fail") === "true",
  );
}
