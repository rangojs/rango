// Volatile leading reference row: `:N<timestamp>` (dev only).
const REFERENCE_ROW_RE = /^:N[\d.]+\n/;
// Absolute file:// paths in dev stack rows. Pattern matches frames
// `["Component","file:///path",<line>,<col>...]` and scrubs the path only.
const FILE_URL_RE = /file:\/\/[^"\\]+(?=",\d+,\d+)/g;

export function normalizeFlight(flight: string): string {
  return flight
    .replace(REFERENCE_ROW_RE, "")
    .replace(FILE_URL_RE, "file://<path>");
}
