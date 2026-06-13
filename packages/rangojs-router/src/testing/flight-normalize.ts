/**
 * normalizeFlight — scrub volatile bits from a Flight wire string so snapshots
 * are stable across runs/machines.
 *
 * This is two regex replacements and NOTHING else. It is split out of flight.ts
 * on purpose: flight.ts top-level imports the vendored react-server-dom
 * serializer, which throws when imported outside the `react-server` export
 * condition. The flight-matchers module (and a consumer's shared `setupFiles`
 * that does `expect.extend(flightMatchers)`) must be importable under the PLAIN
 * node condition, so the normalizer it needs cannot live next to that import.
 * flight.ts re-exports normalizeFlight from here, so the public surface of the
 * `@rangojs/router/testing/flight` entry is unchanged.
 */

// Volatile leading reference row: `:N<timestamp>` (dev debug-info anchor).
const REFERENCE_ROW_RE = /^:N[\d.]+\n/;
// Absolute file:// paths embedded in dev STACK rows. The serializer emits stack
// frames as `["Component","file:///abs/path.tsx",<line>,<col>,...]`, so the
// path is a quoted JSON string immediately followed by `",<line>,<col>`. The
// lookahead scopes the scrub to exactly that frame shape, leaving a legitimate
// `file://` href in RENDERED content (e.g. `{"href":"file:///x"}`) untouched.
const FILE_URL_RE = /file:\/\/[^"\\]+(?=",\d+,\d+)/g;

/**
 * Scrub volatile bits from a Flight string so snapshots are stable across runs
 * and machines:
 * - the leading `:N<timestamp>` reference row (dev only),
 * - absolute `file://...` paths inside dev stack rows.
 *
 * Under NODE_ENV=production these rows are already absent; normalize is a
 * no-op safety net there. In dev mode it removes the machine/clock-specific
 * noise while leaving the rendered tree intact.
 */
export function normalizeFlight(flight: string): string {
  return flight
    .replace(REFERENCE_ROW_RE, "")
    .replace(FILE_URL_RE, "file://<path>");
}
