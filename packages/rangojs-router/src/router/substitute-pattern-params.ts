import { encodePathSegment, encodePathRemainder } from "./url-params.js";
import { parsePattern } from "./parse-pattern.js";

/**
 * Substitute `:param` placeholders in a route pattern with values from
 * `params`, producing a URL. Built by walking the SAME parsed segments the
 * matcher uses (`parsePattern`) and emitting one piece per segment — so a
 * substituted value is never re-scanned as if it were another placeholder (a
 * catch-all value like `sha:abc/x` used to make the "required" pass read `:abc`
 * and throw). Constraint syntax (`:name(en|gb)`) is stripped; trailing-slash
 * patterns like `/blog/` are preserved unless an optional segment was omitted.
 *
 * Semantics per segment:
 * - static             -> emitted verbatim.
 * - `:name`            -> required; `undefined` throws, `""` yields an empty segment.
 * - `:name?`           -> optional; `undefined`/`""` omitted.
 * - `:name*` / `:name+`-> catch-all; the value is multi-segment, so each segment
 *                         is encoded and the `/` separators are preserved. `+`
 *                         (one-or-more) throws when absent; `*` (and bare `*`)
 *                         omit when absent.
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
  const hasTrailingSlash = pattern.length > 1 && pattern.endsWith("/");
  const normalized = hasTrailingSlash ? pattern.slice(0, -1) : pattern;
  const segments = parsePattern(normalized);

  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "static") {
      parts.push("/" + seg.value);
    } else if (seg.type === "wildcard") {
      const value = params[seg.value];
      if (value === undefined || value === "") {
        // `:name+` requires at least one segment; bare `*` / `:name*` collapse.
        if (seg.oneOrMore) {
          throw new Error(
            `Missing param "${seg.value}" for route "${routeName}"`,
          );
        }
      } else {
        parts.push("/" + encodePathRemainder(value));
      }
    } else {
      // Plain param. Constraint (`seg.constraint`) is intentionally not re-emitted.
      const value = params[seg.value];
      const suffix = seg.suffix ?? "";
      if (seg.optional) {
        // The matcher omits absent optionals (`undefined`); callers/getParams()
        // may pass `""` explicitly — treat both as absent.
        if (value !== undefined && value !== "") {
          parts.push("/" + encodePathSegment(value) + suffix);
        }
      } else {
        if (value === undefined) {
          throw new Error(
            `Missing param "${seg.value}" for route "${routeName}"`,
          );
        }
        parts.push("/" + encodePathSegment(value) + suffix);
      }
    }
  }

  let result = parts.join("") || "/";
  if (hasTrailingSlash && !result.endsWith("/")) result += "/";
  return result;
}
