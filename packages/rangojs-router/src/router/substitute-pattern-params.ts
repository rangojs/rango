import { encodePathSegment } from "./url-params.js";

/**
 * Substitute `:param` placeholders in a route pattern with values from
 * `params`. Two-pass: optional params (`:name?`) first so absent values
 * collapse cleanly, then required params (throws on missing). Constraint
 * syntax (`:name(en|gb)`) is stripped from the result. Trailing-slash
 * patterns like `/blog/` are preserved unless an optional segment was
 * actually omitted.
 *
 * Shared by `ctx.reverse()` (server), `createReverse()` (typed runtime
 * helper), and `useReverse()` (client hook). The behavior must stay
 * identical across all three call sites.
 */
export function substitutePatternParams(
  pattern: string,
  params: Record<string, string | undefined>,
  routeName: string,
): string {
  let result = pattern;
  let hadOmittedOptional = false;

  result = result.replace(
    /:([a-zA-Z_][a-zA-Z0-9_]*)(\([^)]*\))?(\?)/g,
    (_match, key) => {
      const value = params[key as string];
      // The matcher omits absent optional params (so `value` is `undefined`
      // here), but caller-supplied params or `getParams()` shapes may still
      // pass `""` explicitly. Treat both as the absent form.
      if (value === undefined || value === "") {
        hadOmittedOptional = true;
        return "";
      }
      return encodePathSegment(value);
    },
  );

  result = result.replace(
    /:([a-zA-Z_][a-zA-Z0-9_]*)(\([^)]*\))?(?!\?)/g,
    (_match, key) => {
      const value = params[key as string];
      if (value === undefined) {
        throw new Error(`Missing param "${key}" for route "${routeName}"`);
      }
      return encodePathSegment(value);
    },
  );

  if (hadOmittedOptional) {
    const hadTrailingSlash = pattern.length > 1 && pattern.endsWith("/");
    result = result.replace(/\/\/+/g, "/").replace(/\/+$/, "") || "/";
    if (hadTrailingSlash && !result.endsWith("/")) result += "/";
  }

  return result;
}
