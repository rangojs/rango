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
 * helper), `useReverse()` (client hook), and the include() mount fill of
 * `useHref()` and relative `useRouter().push`. The behavior must stay
 * identical across all of them.
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

/**
 * Join an include() mount with a mount-relative pattern. The mount is the
 * include PATTERN (`/:locale?`), so the result is a pattern too.
 *
 * `pattern === "/"` is the index of the local module: under a non-root mount
 * it collapses, so `/` under `/blog` becomes `/blog`, not `/blog/`. This
 * matches `ctx.reverse(".index")` and, for a mount without a trailing slash,
 * the route pattern the server registers (applyUrlPrefix in
 * urls/path-helper.ts).
 */
export function joinMount(mount: string, pattern: string): string {
  if (pattern === "/") {
    if (mount === "" || mount === "/") return "/";
    return mount.endsWith("/") ? mount.slice(0, -1) : mount;
  }
  const normalizedMount = mount === "/" ? "" : mount.replace(/\/+$/, "");
  return normalizedMount + pattern;
}

/**
 * Whether two matches of an include() mount pattern are in the same instance
 * of the include: `/en/...` and `/de/...` under `/:locale` are not.
 */
export function sameMountInstance(
  mount: string,
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  return (
    substitutePatternParams(mount, a, mount) ===
    substitutePatternParams(mount, b, mount)
  );
}
