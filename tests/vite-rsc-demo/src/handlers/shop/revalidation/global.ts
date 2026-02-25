import type { Revalidate, GenericParams } from "@rangojs/router";

export const globalRevalidation: Revalidate<GenericParams, RSCRouter.Env> = ({
  defaultShouldRevalidate,
}) => {
  console.log(
    "[Shop] Global revalidation check - defaultShouldRevalidate:",
    defaultShouldRevalidate,
  );
  // Soft decision - pass suggestion to next revalidation
  return { defaultShouldRevalidate };
};
