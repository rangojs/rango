"use server";

/** /nav-idle: a slow action, so useNavigation() can be read while it runs. */
export async function navIdleSlowAction(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return "done";
}
