/**
 * Content Negotiation Utilities
 *
 * Pure functions for HTTP Accept header parsing and response type matching.
 * Used by previewMatch and classifyRequest for content negotiation between
 * RSC routes and response routes (JSON, text, image, stream, etc.).
 */

import type { EntryData } from "../server/context.js";
import type { NegotiateVariant } from "../build/route-trie.js";
import type { CollectedMiddleware } from "./middleware-types.js";
import { collectRouteMiddleware } from "./middleware.js";
import { loadManifest } from "./manifest.js";
import { traverseBack } from "./pattern-matching.js";
import type { RouteMatchResult } from "./pattern-matching.js";
import type { RouteSnapshot } from "./route-snapshot.js";

export const RESPONSE_TYPE_MIME: Record<string, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
  md: "text/markdown",
};

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
    const mime = segments[0]!.trim().toLowerCase();
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
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  return entries;
}

export const RSC_RESPONSE_TYPE = "__rsc__";

/** RSC wire-format MIME type; explicit-opt-in flight transport. */
export const RSC_WIRE_MIME = "text/x-component";

/**
 * The two representations an RSC route serves, in canonical-first order:
 * text/html (the document) and text/x-component (the flight wire format).
 * Both register as negotiation candidates in pickNegotiateVariant; without
 * the wire-format entry, an explicit Accept: text/x-component fell through
 * to the definition-order fallback — a JSON-first route answered a
 * wire-format request with JSON. Which representation an RSC win actually
 * renders is decided by prefersFlightRepresentation below, from the same
 * Accept header (wired in via isRscRequest, rsc/ssr-setup.ts).
 */
const RSC_MIMES: readonly string[] = ["text/html", RSC_WIRE_MIME];

/**
 * Rank the RSC route's two representations against a parsed Accept list:
 * true when the flight wire format outranks the HTML document. Wildcard
 * entries count for the HTML side — they express "anything", and the
 * canonical representation of anything is the document. Co-located with
 * RSC_MIMES so the candidate registration and the representation choice
 * cannot drift.
 */
export function prefersFlightRepresentation(
  acceptEntries: AcceptEntry[],
): boolean {
  for (const entry of acceptEntries) {
    if (entry.q === 0) continue;
    if (entry.mime === RSC_WIRE_MIME) return true;
    if (
      entry.mime === "text/html" ||
      entry.mime === "text/*" ||
      entry.mime === "*/*"
    ) {
      return false;
    }
  }
  return false;
}

/**
 * Pick the best negotiate variant by walking the client's sorted Accept list.
 * For each accepted MIME type (in q-value/order priority), check if any
 * candidate serves that type. Wildcards match the first candidate.
 * Falls back to the first candidate if nothing matches.
 */
export function pickNegotiateVariant<
  T extends { routeKey: string; responseType: string },
>(acceptEntries: AcceptEntry[], candidates: T[]): T {
  const byCandidateMime = new Map<string, T>();
  for (const c of candidates) {
    const mimes =
      c.responseType === RSC_RESPONSE_TYPE
        ? RSC_MIMES
        : [RESPONSE_TYPE_MIME[c.responseType]];
    for (const mime of mimes) {
      if (mime && !byCandidateMime.has(mime)) {
        byCandidateMime.set(mime, c);
      }
    }
  }

  for (const entry of acceptEntries) {
    if (entry.q === 0) continue;
    if (entry.mime === "*/*") return candidates[0]!;
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
  return candidates[0]!;
}

/**
 * Re-key params from the primary leaf's names to a winning variant's names.
 *
 * The trie match builds `params` positionally under the primary leaf's pa, so
 * `/widgets/:id` matched as the primary yields `{ id }` even when the winning
 * `/widgets/:file` response variant expects `{ file }`. Both share the same trie
 * terminal, so they bind the same number of positional named params; we zip the
 * variant's pa against the named values in insertion order (which is the
 * primary's pa order). The wildcard key (`*`) is positional-independent and left
 * untouched.
 *
 * Mutates `params` in place. No-op when `variantPa` is absent, when names already
 * match (the common case), or when the positional count diverges (defensive:
 * never corrupt params by zipping mismatched lengths).
 */
export function rekeyParamsForVariant(
  params: Record<string, string>,
  variantPa: string[] | undefined,
): void {
  if (!variantPa || variantPa.length === 0) return;

  const namedKeys: string[] = [];
  for (const key in params) {
    if (key !== "*") namedKeys.push(key);
  }
  if (namedKeys.length !== variantPa.length) return;

  let identical = true;
  for (let i = 0; i < variantPa.length; i++) {
    if (namedKeys[i] !== variantPa[i]) {
      identical = false;
      break;
    }
  }
  if (identical) return;

  const values = namedKeys.map((k) => params[k]!);
  for (const key of namedKeys) delete params[key];
  for (let i = 0; i < variantPa.length; i++) {
    params[variantPa[i]!] = values[i]!;
  }
}

/**
 * Result of content negotiation for a route with negotiate variants.
 */
export interface NegotiationResult {
  /** The winning response type */
  responseType: string;
  /** Handler function for the winning variant */
  handler: Function;
  /** Manifest entry for the winning variant (may differ from primary) */
  manifestEntry: EntryData;
  /** Route middleware for the winning variant */
  routeMiddleware: CollectedMiddleware[];
  /** True when negotiation selected a variant; false for a plain response route. */
  negotiated: boolean;
}

/**
 * Perform content negotiation for a route with negotiate variants.
 *
 * Returns a NegotiationResult when a response route wins negotiation.
 * Returns null when RSC wins or no negotiation is needed.
 *
 * Shared by previewMatch and classifyRequest to avoid duplicating
 * the candidate-building and variant-loading logic.
 */
export async function negotiateRoute(
  request: Request,
  pathname: string,
  snapshot: RouteSnapshot,
): Promise<NegotiationResult | null> {
  const { matched, manifestEntry, routeMiddleware, responseType } = snapshot;
  if (!matched.negotiateVariants || matched.negotiateVariants.length === 0) {
    // No variants: a plain response route still yields a result (negotiated:false)
    // so callers don't re-derive it; RSC routes (no responseType/handler) -> null.
    const handler =
      manifestEntry.type === "route" ? manifestEntry.handler : undefined;
    if (responseType && handler) {
      return {
        responseType,
        handler: handler as Function,
        manifestEntry,
        routeMiddleware,
        negotiated: false,
      };
    }
    return null;
  }

  const acceptEntries = parseAcceptTypes(request.headers.get("accept") || "");

  // Variants carry the variant's own pa (positional param names); the synthetic
  // primary/RSC candidates have none (their params are already keyed correctly).
  const variants = matched.negotiateVariants as NegotiateVariant[];
  let candidates: NegotiateVariant[];
  if (responseType) {
    candidates = [...variants, { routeKey: matched.routeKey, responseType }];
  } else {
    const rscCandidate = {
      routeKey: matched.routeKey,
      responseType: RSC_RESPONSE_TYPE,
    };
    candidates = matched.rscFirst
      ? [rscCandidate, ...variants]
      : [...variants, rscCandidate];
  }

  const variant = pickNegotiateVariant(acceptEntries, candidates);

  if (variant.responseType === RSC_RESPONSE_TYPE) {
    return null;
  }

  if (responseType && variant.routeKey === matched.routeKey) {
    return {
      responseType,
      handler: manifestEntry.handler as Function,
      manifestEntry,
      routeMiddleware,
      negotiated: true,
    };
  }
  // The trie extracted params under the PRIMARY leaf's pa, but the winning
  // variant's handler is keyed by the variant's own param names. Re-key in place
  // so plan.route.params (and the variant middleware collected just below) see
  // the variant's names. No-op when the variant has no pa or shares the primary's
  // names (the common case).
  rekeyParamsForVariant(matched.params, variant.pa);
  const negotiateEntry = await loadManifest(
    matched.entry,
    variant.routeKey,
    pathname,
    undefined,
    false,
  );
  const variantMiddleware = collectRouteMiddleware(
    traverseBack(negotiateEntry),
    matched.params,
  );
  return {
    responseType: variant.responseType,
    handler: negotiateEntry.handler as Function,
    manifestEntry: negotiateEntry,
    routeMiddleware: variantMiddleware,
    negotiated: true,
  };
}
