import type { ShouldRevalidateFn, GenericParams } from "@rangojs/router/server";

// Global soft decision: suggests revalidation but allows override
export const globalRevalidation: ShouldRevalidateFn<GenericParams, RSCRouter.Env> = () => {
  console.log("[Admin] Global: SOFT decision - suggest revalidate=true, continue...");
  return { defaultShouldRevalidate: true }; // SOFT: continue to next revalidator
};

// Settings page: HARD decision - never revalidate (static)
export const settingsRevalidation: ShouldRevalidateFn = () => {
  console.log("[Admin] Settings: HARD decision - never revalidate");
  return false; // HARD: short-circuit, don't revalidate
};

// User detail: HARD decision - only if ID changes
export const userRevalidation: ShouldRevalidateFn<{ id: string }> = (params) => {
  const changed = params.currentParams.id !== params.nextParams.id;
  console.log(`[Admin] User detail: HARD decision - ID changed=${changed}`);
  return changed; // HARD: short-circuit with this value
};
