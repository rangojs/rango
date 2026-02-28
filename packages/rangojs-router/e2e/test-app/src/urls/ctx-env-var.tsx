import { urls, createLoader, type Middleware } from "@rangojs/router";
import { getRequestContext } from "@rangojs/router/rsc";

/**
 * Loader that captures its view of ctx.env and ctx.get().
 * Returns the env type and variable value so the handler can render them.
 */
export const EnvVarLoader = createLoader(async (ctx) => {
  const reqCtx = getRequestContext();
  return {
    loaderEnvType: typeof ctx.env,
    loaderEnvStr: JSON.stringify(ctx.env),
    loaderVar: ctx.get("envTestVar") ?? "undefined",
    reqCtxEnvType: typeof reqCtx?.env,
    reqCtxEnvStr: JSON.stringify(reqCtx?.env),
    reqCtxVar: reqCtx?.get("envTestVar") ?? "undefined",
  };
});

/**
 * Route middleware that captures its view of ctx.env and ctx.get().
 * Sets test variables so downstream handlers/loaders can read them.
 */
const envVarMiddleware: Middleware = async (ctx, next) => {
  // Set a variable to verify flow from middleware to handler/loader
  ctx.set("envTestVar", "from-middleware");
  // Capture middleware's view of env
  ctx.set("mwEnvType", typeof ctx.env);
  ctx.set("mwEnvKeys", JSON.stringify(Object.keys(ctx.env)));
  await next();
};

/**
 * Test route for verifying ctx.env and ctx.var consistency across all context types:
 * - HandlerContext (route handler)
 * - MiddlewareContext (route middleware)
 * - LoaderContext (createLoader)
 * - RequestContext (getRequestContext())
 *
 * All context types should see the same env shape and variable values.
 */
export const ctxEnvVarPatterns = urls(({ path, loader, middleware }) => [
  path(
    "/",
    async (ctx) => {
      // Handler's view of env and var
      const handlerEnvType = typeof ctx.env;
      const handlerEnvStr = JSON.stringify(ctx.env);
      const handlerVar = ctx.get("envTestVar") ?? "undefined";

      // Middleware-captured values (set by envVarMiddleware)
      const mwEnvType = ctx.get("mwEnvType") ?? "undefined";
      const mwEnvKeys = ctx.get("mwEnvKeys") ?? "undefined";

      // Loader data (contains loader + requestContext values)
      const loaderData = await ctx.use(EnvVarLoader);

      return (
        <div data-testid="ctx-env-var-page">
          <h1>ctx.env/ctx.var Consistency Test</h1>

          <section>
            <h2>Handler Context</h2>
            <p data-testid="handler-env-type">{handlerEnvType}</p>
            <p data-testid="handler-env-str">{handlerEnvStr}</p>
            <p data-testid="handler-var">{handlerVar}</p>
          </section>

          <section>
            <h2>Middleware Context</h2>
            <p data-testid="middleware-env-type">{mwEnvType}</p>
            <p data-testid="middleware-env-keys">{mwEnvKeys}</p>
          </section>

          <section>
            <h2>Loader Context</h2>
            <p data-testid="loader-env-type">{loaderData.loaderEnvType}</p>
            <p data-testid="loader-env-str">{loaderData.loaderEnvStr}</p>
            <p data-testid="loader-var">{loaderData.loaderVar}</p>
          </section>

          <section>
            <h2>RequestContext (via getRequestContext)</h2>
            <p data-testid="reqctx-env-type">{loaderData.reqCtxEnvType}</p>
            <p data-testid="reqctx-env-str">{loaderData.reqCtxEnvStr}</p>
            <p data-testid="reqctx-var">{loaderData.reqCtxVar}</p>
          </section>
        </div>
      );
    },
    { name: "index" },
    () => [loader(EnvVarLoader), middleware(envVarMiddleware)],
  ),

  // JSON response handler route: tests ResponseHandlerContext env/var consistency
  path.json(
    "/json",
    (ctx) => {
      const reqCtx = getRequestContext();
      return {
        handlerEnvType: typeof ctx.env,
        handlerEnvStr: JSON.stringify(ctx.env),
        handlerVar: ctx.get("envTestVar") ?? "undefined",
        mwEnvType: ctx.get("mwEnvType") ?? "undefined",
        mwEnvKeys: ctx.get("mwEnvKeys") ?? "undefined",
        reqCtxEnvType: typeof reqCtx?.env,
        reqCtxEnvStr: JSON.stringify(reqCtx?.env),
        reqCtxVar: reqCtx?.get("envTestVar") ?? "undefined",
      };
    },
    { name: "json" },
    () => [middleware(envVarMiddleware)],
  ),
]);
