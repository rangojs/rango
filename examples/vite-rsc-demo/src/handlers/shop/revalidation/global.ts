import type { ShouldRevalidateFn, GenericParams } from "@rangojs/router/server";

export const globalRevalidation: ShouldRevalidateFn<
  GenericParams,
  RSCRouter.Env
> = ({ defaultShouldRevalidate }) => {
  console.log(
    "[Shop] Global revalidation check - defaultShouldRevalidate:",
    defaultShouldRevalidate
  );
  // Soft decision - pass suggestion to next revalidation
  return { defaultShouldRevalidate };
};
