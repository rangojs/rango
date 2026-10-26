// A "use cache" function that fails on demand, for on-error-context.
export const state: { failing: boolean } = { failing: false };

export async function getStamp(): Promise<string> {
  "use cache: short";
  if (state.failing) throw new Error("use cache down");
  return "stamp-ok";
}
