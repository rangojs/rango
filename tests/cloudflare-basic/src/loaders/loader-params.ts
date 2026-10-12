import { createLoader } from "@rangojs/router";

/**
 * Fetchable loader for /loader-params (#1109): its params reach ctx.params
 * only as string values.
 */
export const LoaderParamsLoader = createLoader(
  async (ctx) => ({ id: ctx.params.id ?? "none" }),
  true,
);
