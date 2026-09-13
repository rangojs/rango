import { createVar, type Middleware } from "@rangojs/router";

// workerd mirror of the test-app "middleware vars" fixture
// (packages/rangojs-router/e2e/client-urls.test.ts); pinned here by
// e2e/client-urls-vars.test.ts. Route middleware writes a createVar() token
// and a string key; the group loader must read both on the document and
// partial lanes.
export const CuVarsUser = createVar<string>();

export const clientUrlsVarsMiddleware: Middleware = async (ctx, next) => {
  ctx.set(CuVarsUser, "alice");
  ctx.set("cuVarsUserStr", "alice-str");
  return next();
};
