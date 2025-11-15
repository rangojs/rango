import type { ShouldRevalidateFn, RouteRevalidateFn, GenericParams, RevalidateParams } from "rsc-router";
import type { adminRoutes } from "@/routes.js";

// Global soft decision: suggests revalidation but allows override
export const globalRevalidation: ShouldRevalidateFn<GenericParams, RSCRouter.Env> = () => {
  console.log("[Admin] Global: SOFT decision - suggest revalidate=true, continue...");
  return { defaultShouldRevalidate: true }; // SOFT: continue to next revalidator
};

// Settings page: HARD decision - never revalidate (static)
export const settingsRevalidation: RouteRevalidateFn<typeof adminRoutes, "settings"> = () => {
  console.log("[Admin] Settings: HARD decision - never revalidate");
  return false; // HARD: short-circuit, don't revalidate
};

// User detail: HARD decision - only if ID changes
export const userRevalidation: RouteRevalidateFn<typeof adminRoutes, "user"> = ((params: RevalidateParams<{ id: string }>) => {
  const changed = params.currentParams.id !== params.nextParams.id;
  console.log(`[Admin] User detail: HARD decision - ID changed=${changed}`);
  return changed; // HARD: short-circuit with this value
});
