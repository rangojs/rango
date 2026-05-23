/**
 * Compile-only assertions for the AUGMENTED Rango namespace.
 *
 * Pins the type-safety contract a consumer gets after augmenting Env, Vars, and
 * GeneratedRouteMap. A regression in the fallback chains (global-namespace.ts)
 * turns these into tsc errors. Run via tsconfig.augment-check.json.
 */
import "./augment.js";
import type { Handler, RouteParams, RouteSearchParams } from "../index.js";
import type { DefaultRouteName } from "../types/global-namespace.js";
import { href } from "../href-client.js";
import type { TestBindings } from "./augment.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Env: ctx.env resolves to the augmented bindings, not `unknown`/`any`.
const envHandler: Handler<"home"> = (ctx) => {
  type _envIsBindings = Expect<Equal<typeof ctx.env, TestBindings>>;
  ctx.env.DB.query("select 1");
  // @ts-expect-error - unknown binding is rejected once Env is augmented
  ctx.env.MISSING();
  return null;
};
void envHandler;

// Vars: ctx.get is keyed by the augmented Vars.
const varsHandler: Handler<"home"> = (ctx) => {
  const user = ctx.get("user");
  type _userTyped = Expect<
    Equal<typeof user, { id: string; role: "admin" | "user" } | undefined>
  >;
  // @ts-expect-error - unknown var key is rejected once Vars is augmented
  ctx.get("nope");
  return null;
};
void varsHandler;

// routeName narrows to the generated route names.
type _routeName = Expect<
  Equal<DefaultRouteName, "home" | "blog.post" | "search">
>;

// RouteParams / RouteSearchParams resolve from the generated map with no
// explicit route map argument.
type _params = Expect<Equal<RouteParams<"blog.post">, { slug: string }>>;
type _search = Expect<
  Equal<RouteSearchParams<"search">, { q: string | undefined; page?: number }>
>;

// href / ValidPaths read GeneratedRouteMap even without a manual RegisteredRoutes
// augmentation — this is the core of the "rango generate alone enables typed
// href()" guarantee. The paths below come from the generated map in augment.ts.
href("/");
href("/blog/anything");
href("/search");
// @ts-expect-error - path is not in the generated route map
href("/not-a-route");

// Reference the top-level assertion aliases so they are unambiguously evaluated.
export type _Assertions = [_routeName, _params, _search];
