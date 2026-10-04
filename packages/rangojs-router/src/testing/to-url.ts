/** Shared string|URL coercion for the testing primitives. */
export function toURL(value: string | URL | undefined, fallback: URL): URL {
  if (value === undefined) return fallback;
  return typeof value === "string" ? new URL(value, fallback.origin) : value;
}
