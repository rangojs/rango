/**
 * Route pattern parsing (grammar only).
 *
 * Deliberately dependency-free so it is safe to bundle into the CLIENT — the
 * reverse helper (`substitute-pattern-params.ts` -> `use-reverse`) needs it, and
 * pulling it from `pattern-matching.ts` would drag that module's server-only
 * transitive imports (`node:async_hooks` via `logging.ts`) into the browser.
 * `pattern-matching.ts` re-exports these so existing importers are unaffected.
 */

/**
 * Parsed segment info
 */
export interface ParsedSegment {
  type: "static" | "param" | "wildcard";
  value: string; // static text, param name, or "*"
  optional: boolean;
  constraint?: string[]; // enum values like ["en", "gb"]
  suffix?: string; // literal text after param in same segment (e.g., ".html")
  /**
   * Named catch-all repeat modifier. On a `wildcard` segment whose `value` is a
   * param name (`:name+` / `:name*`), `true` marks one-or-more (`+`, rejects the
   * zero-segment case); absent/false marks zero-or-more (`*`, and the bare `/*`).
   */
  oneOrMore?: boolean;
}

/**
 * Parse a route pattern into segments
 *
 * Supports:
 * - Static: /blog, /about
 * - Params: /:slug, /:id
 * - Optional: /:locale?, /:page?
 * - Constrained: /:locale(en|gb), /:type(post|page)
 * - Optional + Constrained: /:locale(en|gb)?
 * - Wildcard: /*
 * - Named catch-all: /:slug* (zero-or-more), /:path+ (one-or-more)
 */
export function parsePattern(pattern: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  // The `([+*])?` group peels a trailing `+`/`*` off a `:name` BEFORE the
  // literal-suffix group `([^/]*)` so it can be inspected. Whether it is a
  // catch-all MODIFIER or a literal suffix character is decided below — a bare
  // trailing `+`/`*` is the named catch-all of issue #634; any other combination
  // is folded back into the literal suffix so previously-valid patterns are
  // unaffected. It sits after `(\?)?` so `:name?*` is seen as `?` + suffix `*`.
  const segmentRegex =
    /\/(:([a-zA-Z_][a-zA-Z0-9_]*)(\(([^)]+)\))?(\?)?([+*])?([^/]*)|(\*)|([^/]+))/g;

  let match;
  while ((match = segmentRegex.exec(pattern)) !== null) {
    const [
      ,
      ,
      paramName,
      ,
      constraint,
      optional,
      repeat,
      suffix,
      wildcard,
      staticText,
    ] = match;

    if (wildcard) {
      // Bare `/*`: zero-or-more, captured under "*".
      segments.push({ type: "wildcard", value: "*", optional: false });
    } else if (paramName) {
      // A trailing `+`/`*` is a named catch-all ONLY when it stands alone on the
      // param — no `?`, no constraint, no literal suffix after it. In any other
      // combination it is the start of a literal suffix, exactly as before this
      // feature existed, so `:version+build` still matches `/…/v1+build` and
      // never throws at registration.
      if (repeat && !suffix && optional !== "?" && !constraint) {
        segments.push({
          type: "wildcard",
          value: paramName,
          optional: false,
          oneOrMore: repeat === "+",
        });
      } else {
        segments.push({
          type: "param",
          value: paramName,
          optional: optional === "?",
          constraint: constraint ? constraint.split("|") : undefined,
          // Fold a non-modifier `+`/`*` back into the literal suffix.
          suffix: (repeat ?? "") + (suffix ?? "") || undefined,
        });
      }
    } else if (staticText) {
      segments.push({ type: "static", value: staticText, optional: false });
    }
  }

  // A named catch-all consumes the remainder, so it only makes sense as the final
  // segment. If it isn't last, it isn't really a catch-all: restore the literal
  // parse (`:name` + literal `+`/`*` suffix) rather than error, so a pattern like
  // `/docs/:slug+/edit` keeps its pre-feature behavior (matches `/docs/x+/edit`).
  // Bare `/*` keeps its historical mid-pattern leniency and is left untouched.
  for (let i = 0; i < segments.length - 1; i++) {
    const s = segments[i];
    if (s.type === "wildcard" && s.value !== "*") {
      segments[i] = {
        type: "param",
        value: s.value,
        optional: false,
        suffix: s.oneOrMore ? "+" : "*",
      };
    }
  }

  return segments;
}
