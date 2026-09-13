import { createVar, type Middleware } from "@rangojs/router";

// Route middleware -> clientUrls() group loader var visibility fixture
// (e2e/client-urls.test.ts "middleware vars"). The token is a plain
// createVar() so the e2e pins Symbol() identity across the middleware module
// and the loader module; the string key is the control that always travels.
export const CuVarsUser = createVar<string>();

export const clientUrlsVarsMiddleware: Middleware = async (ctx, next) => {
  ctx.set(CuVarsUser, "alice");
  ctx.set("cuVarsUserStr", "alice-str");
  return next();
};
