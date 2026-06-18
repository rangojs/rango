/**
 * Escape a JSON (or JSON-derived) string for safe embedding inside an HTML
 * <script> element via dangerouslySetInnerHTML. Without this a value containing
 * "</script>" closes the tag early — the rest of the page leaks as raw HTML, and
 * in an executable script the trailing content runs. Escaping "<" defeats the
 * early close; ">" and "&" are escaped for completeness so the serialized payload
 * can never form HTML syntax. The result is still valid JSON and a valid JS
 * string literal (\uXXXX escapes are legal in both) and re-parses identically.
 *
 * Used by every site that interpolates JSON.stringify(...) into inline <script>
 * content: the JSON-LD meta descriptors (handles/MetaTags) and the FOUC theme
 * init script (theme/theme-script).
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
