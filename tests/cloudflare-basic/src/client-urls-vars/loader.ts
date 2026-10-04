import { createLoader, type LoaderContext } from "@rangojs/router";
import { CuVarsUser, clientUrlsVarsMiddleware } from "./shared.js";

function readVars(ctx: LoaderContext): string {
  return `var:${ctx.get(CuVarsUser) ?? "undefined"}|str:${ctx.get("cuVarsUserStr") ?? "undefined"}`;
}

// Projected group loader: inside the route middleware chain.
export const ClientUrlsVarsLoader = createLoader(async (ctx) => readVars(ctx));

// Fetch lane with an empty per-loader list: route middleware does not run.
export const ClientUrlsVarsFetchBareLoader = createLoader(
  async (ctx) => readVars(ctx),
  true,
);

// Fetch lane with the middleware attached per loader.
export const ClientUrlsVarsFetchMwLoader = createLoader(
  async (ctx) => readVars(ctx),
  { middleware: [clientUrlsVarsMiddleware] },
);
