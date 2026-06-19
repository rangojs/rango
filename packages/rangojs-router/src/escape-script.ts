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

/**
 * Escape an inline <script> body so it cannot terminate or corrupt the document.
 * Two sequences are rewritten, each via a JS escape that is valid in string,
 * template, regex (including the `u`/`v` flags), and JSON contexts — so the body
 * still parses identically as code AND as JSON (application/json, ld+json):
 * - "</script" -> "<\/script": stops a literal close tag inside the body from
 *   ending the element early. `\/` is a valid JSON escape and a valid regex escape.
 * - "<!--": the "!" (U+0021) is emitted as a unicode escape (see the replacement
 *   string below), so the literal "<!--" token never reaches the HTML parser. A
 *   literal "<!--" puts the parser into the "script data escaped" state and a
 *   following "<script" into "script data DOUBLE escaped", where the real
 *   "</script>" no longer closes the element — `var x = "<!--<script>"` would
 *   swallow the rest of the document. The unicode-escape form decodes back to "!"
 *   in string/template/JSON/regex contexts, unlike "\!" (invalid JSON, invalid
 *   /u-regex escape).
 * Real operators such as `a < b` and `a && b` are untouched (unlike
 * escapeJsonForScript, which \u-escapes every "<", "&", ">").
 *
 * GUARANTEE / LIMITATION: value-preserving for the contexts where these sequences
 * legitimately appear — string/template literals, regexes (incl. `u`/`v`), and
 * JSON. It is NOT source-text-preserving (e.g. String.raw`</script>` sees the
 * extra backslash), and it cannot rewrite "</script"/"<!--" that appear as bare
 * code (a legacy `<!--` line comment, or `</script` outside any literal) — neither
 * occurs in valid script payloads. Not a general sanitizer for arbitrary UNTRUSTED
 * source; for untrusted dynamic data, JSON-encode it and read it back, rather than
 * inlining it as code.
 *
 * Used by the Script handle's <Scripts> renderer for inline `children`.
 */
export function escapeScriptBody(js: string): string {
  return js.replace(/<!--/g, "<\\u0021--").replace(/<\/(script)/gi, "<\\/$1");
}
