"use server";

/**
 * /action-persists*: a save that answers after 300 ms with the label it was
 * given, or throws when told to fail.
 */
export async function actionPersistsSave(
  label: string,
  fail: boolean,
): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (fail) throw new Error("save failed");
  return label;
}
