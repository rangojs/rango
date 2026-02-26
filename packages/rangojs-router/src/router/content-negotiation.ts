/**
 * Content Negotiation Utilities
 *
 * Pure functions for HTTP Accept header parsing and response type matching.
 * Used by createRouter's previewMatch for content negotiation between
 * RSC routes and response routes (JSON, text, image, stream, etc.).
 */

// Response type -> MIME type used for Accept header matching
export const RESPONSE_TYPE_MIME: Record<string, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
  md: "text/markdown",
};

// Reverse lookup: MIME type -> response type tag (e.g. "text/html" -> "html")
export const MIME_RESPONSE_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(RESPONSE_TYPE_MIME).map(([tag, mime]) => [mime, tag]),
);

export type NamedRouteEntry =
  | string
  | { path: string; search?: Record<string, string> };

export function flattenNamedRoutes(
  routeNames?: Record<string, NamedRouteEntry>,
): Record<string, string> {
  if (!routeNames) return {};
  const flattened: Record<string, string> = {};
  for (const [name, entry] of Object.entries(routeNames)) {
    flattened[name] = typeof entry === "string" ? entry : entry.path;
  }
  return flattened;
}

export interface AcceptEntry {
  mime: string;
  q: number;
  order: number;
}

/**
 * Parse an Accept header into a sorted array of MIME entries.
 * Respects q-values (default 1.0) and uses client order as tiebreaker
 * when q-values are equal (matching Express/Hono behavior).
 */
export function parseAcceptTypes(accept: string): AcceptEntry[] {
  const entries: AcceptEntry[] = [];
  const parts = accept.split(",");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const segments = part.split(";");
    const mime = segments[0]!.trim();
    if (!mime) continue;
    let q = 1.0;
    for (let j = 1; j < segments.length; j++) {
      const param = segments[j]!.trim();
      if (param.startsWith("q=")) {
        q = Math.max(0, Math.min(1, Number(param.slice(2)) || 0));
      }
    }
    entries.push({ mime, q, order: i });
  }
  // Sort: highest q first, then lowest client order first (stable)
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  return entries;
}

// Sentinel response type for RSC routes in negotiation candidates
export const RSC_RESPONSE_TYPE = "__rsc__";

/**
 * Pick the best negotiate variant by walking the client's sorted Accept list.
 * For each accepted MIME type (in q-value/order priority), check if any
 * candidate serves that type. Wildcards match the first candidate.
 * Falls back to the first candidate if nothing matches.
 */
export function pickNegotiateVariant(
  acceptEntries: AcceptEntry[],
  candidates: Array<{ routeKey: string; responseType: string }>,
): { routeKey: string; responseType: string } {
  // Build a MIME -> candidate lookup for O(1) matching
  const byCandidateMime = new Map<
    string,
    { routeKey: string; responseType: string }
  >();
  for (const c of candidates) {
    const mime =
      c.responseType === RSC_RESPONSE_TYPE
        ? "text/html"
        : RESPONSE_TYPE_MIME[c.responseType];
    if (mime && !byCandidateMime.has(mime)) {
      byCandidateMime.set(mime, c);
    }
  }

  for (const entry of acceptEntries) {
    if (entry.q === 0) continue;
    // Wildcard matches first candidate
    if (entry.mime === "*/*") return candidates[0]!;
    // Type wildcard (e.g. "text/*") -- match first candidate with that type
    if (entry.mime.endsWith("/*")) {
      const typePrefix = entry.mime.slice(0, entry.mime.indexOf("/"));
      for (const [mime, candidate] of byCandidateMime) {
        if (mime.startsWith(typePrefix + "/")) return candidate;
      }
      continue;
    }
    const match = byCandidateMime.get(entry.mime);
    if (match) return match;
  }
  // No match -- use first candidate as default
  return candidates[0]!;
}
