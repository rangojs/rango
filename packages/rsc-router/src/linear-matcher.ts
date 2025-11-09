/**
 * Linear Pattern Matcher - Hono-inspired route matching
 * Implements lazy compilation with JIT (Just-In-Time) pattern compilation
 */

/**
 * Match result returned by matcher
 */
export interface MatchResult {
  matched: boolean;
  params: Record<string, string>;
}

/**
 * Compiled pattern information (cached)
 */
interface CompiledPattern {
  regex: RegExp;
  paramNames: string[];
}

/**
 * Linear pattern matcher with lazy compilation
 * Inspired by Hono's approach for optimal serverless performance
 *
 * Features:
 * - Lazy evaluation: No compilation until first match
 * - JIT compilation: Pattern compiled on first use, cached for reuse
 * - Memory efficient: Minimal footprint
 * - Fast matching: Regex-based with early termination
 *
 * @example
 * ```typescript
 * const matcher = new LinearMatcher('/users/:id');
 *
 * // First match: compiles pattern (JIT)
 * matcher.match('/users/123');  // { matched: true, params: { id: '123' } }
 *
 * // Subsequent matches: uses cached compilation
 * matcher.match('/users/456');  // { matched: true, params: { id: '456' } }
 * ```
 */
export class LinearMatcher {
  /**
   * Original pattern string (e.g., '/users/:id')
   */
  private pattern: string;

  /**
   * Compiled pattern (lazy - only set after first match)
   */
  private compiled?: CompiledPattern;

  /**
   * Create a new matcher for the given pattern
   * Note: Pattern is NOT compiled until first match (lazy evaluation)
   *
   * @param pattern - Route pattern (e.g., '/users/:id', '/blog/:category/:slug')
   */
  constructor(pattern: string) {
    this.pattern = pattern;
    // No compilation here - lazy!
  }

  /**
   * Match a path against this pattern
   * Compiles pattern on first call (JIT), then caches for performance
   *
   * @param path - Path to match (e.g., '/users/123')
   * @returns Match result with params if matched
   */
  match(path: string): MatchResult {
    // Lazy compilation: compile on first use
    if (!this.compiled) {
      this.compiled = this.compile(this.pattern);
    }

    // Test path against compiled regex
    const match = this.compiled.regex.exec(path);

    if (!match) {
      return { matched: false, params: {} };
    }

    // Extract params from match groups
    const params: Record<string, string> = {};
    for (let i = 0; i < this.compiled.paramNames.length; i++) {
      const paramName = this.compiled.paramNames[i];
      const paramValue = match[i + 1]; // Regex groups start at index 1
      if (paramName && paramValue) {
        params[paramName] = paramValue;
      }
    }

    return { matched: true, params };
  }

  /**
   * Compile pattern to regex (JIT - Just-In-Time)
   * This is called only once per matcher instance
   *
   * @param pattern - Route pattern
   * @returns Compiled pattern with regex and param names
   * @internal
   */
  private compile(pattern: string): CompiledPattern {
    const paramNames: string[] = [];

    // Split pattern into segments
    const segments = pattern.split('/');

    // Build regex pattern from segments
    const regexParts = segments.map((segment) => {
      if (!segment) {
        // Empty segment (from leading/trailing slash)
        return '';
      }

      if (segment.includes(':')) {
        // Segment contains dynamic part(s)
        // Examples: :id, :id.json, :filename.:ext
        let regexPart = '';
        let remaining = segment;

        while (remaining) {
          const colonIndex = remaining.indexOf(':');

          if (colonIndex === -1) {
            // No more dynamic parts, rest is static
            regexPart += this.escapeRegex(remaining);
            break;
          }

          // Add static part before :
          if (colonIndex > 0) {
            regexPart += this.escapeRegex(remaining.slice(0, colonIndex));
          }

          // Extract param name (up to . or / or ? or end)
          remaining = remaining.slice(colonIndex + 1);
          const match = remaining.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);

          if (match && match[1]) {
            const paramName = match[1];
            paramNames.push(paramName);
            remaining = remaining.slice(paramName.length);

            // Check if optional
            const isOptional = remaining.startsWith('?');
            if (isOptional) {
              remaining = remaining.slice(1);
            }

            // Dynamic param matches anything except / and .
            // Use [^/.] to stop at dots (for extensions)
            regexPart += isOptional ? '([^/.]+)?' : '([^/.]+)';
          }
        }

        return regexPart;
      }

      // Static segment: escape regex special characters
      return this.escapeRegex(segment);
    });

    // Join segments back with /
    const regexPattern = regexParts.join('/');

    // Create regex with anchors (^ and $) for exact matching
    const regex = new RegExp(`^${regexPattern}$`);

    return { regex, paramNames };
  }

  /**
   * Escape special regex characters in static segments
   * @param str - String to escape
   * @returns Escaped string safe for regex
   * @internal
   */
  private escapeRegex(str: string): string {
    // Escape regex special characters: . * + ? ^ $ { } ( ) | [ ] \
    return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get the original pattern
   * @returns Pattern string
   */
  getPattern(): string {
    return this.pattern;
  }

  /**
   * Check if pattern has been compiled (for testing/debugging)
   * @returns True if compiled
   */
  isCompiled(): boolean {
    return this.compiled !== undefined;
  }
}
