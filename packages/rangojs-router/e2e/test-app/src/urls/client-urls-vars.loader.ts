import { createLoader, type LoaderContext } from "@rangojs/router";
import {
  CuVarsUser,
  clientUrlsVarsMiddleware,
} from "./client-urls-vars-shared.js";

function readVars(ctx: LoaderContext): string {
  return `var:${ctx.get(CuVarsUser) ?? "undefined"}|str:${ctx.get("cuVarsUserStr") ?? "undefined"}`;
}

// Projected group loader: runs inside the route middleware chain on the
// document and _rsc_partial lanes.
export const ClientUrlsVarsLoader = createLoader(async (ctx) => readVars(ctx));

// Fetch lane (_rsc_loader) with an empty per-loader middleware list: route
// middleware does NOT run here, so both reads miss.
export const ClientUrlsVarsFetchBareLoader = createLoader(
  async (ctx) => readVars(ctx),
  true,
);

// Fetch lane with the middleware attached per loader: both reads hit.
export const ClientUrlsVarsFetchMwLoader = createLoader(
  async (ctx) => readVars(ctx),
  { middleware: [clientUrlsVarsMiddleware] },
);
