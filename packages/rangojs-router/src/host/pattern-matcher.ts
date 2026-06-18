/**
 * Pattern Matching Engine
 *
 * Handles matching of hostnames and paths against various patterns:
 * - `.` or `*` - any apex domain
 * - `**` - any domain (apex + subdomains)
 * - `*.` - any single-level subdomain
 * - `**.` - any multi-level subdomain
 * - `example.com` - exact domain
 * - `*.com` - any apex .com domain
 * - `*.example.com` - subdomain of example.com
 * - `**.example.com` - any depth subdomain
 * - `admin.*` - admin subdomain of any apex
 * - `example.com/admin` - specific domain with path prefix
 *
 * Apex vs subdomain is classified purely by dot-part COUNT (apex == exactly 2
 * parts) — there is no Public Suffix List. A registrable domain under a
 * multi-label public suffix (example.co.uk, shop.com.au) has 3+ parts and is
 * therefore treated as a SUBDOMAIN, not an apex: `.`/`*` will NOT match it and
 * `*.` WILL. If registrable-domain accuracy matters for a host-router consumer,
 * supply an explicit apex/host hint rather than relying on the part count.
 */

import { InvalidPatternError } from "./errors.js";

export function normalizePattern(pattern: string): string {
  const slashIndex = pattern.indexOf("/");
  if (slashIndex !== -1) {
    const domain = pattern.slice(0, slashIndex);
    const path = pattern.slice(slashIndex).replace(/\/$/, "");
    return domain + path;
  }
  return pattern;
}

export function parseRequest(request: Request): {
  hostname: string;
  pathname: string;
  parts: string[];
} {
  const url = new URL(request.url);
  const hostname = url.hostname;
  const pathname = url.pathname;
  const parts = hostname.split(".");

  return { hostname, pathname, parts };
}

function getSubdomainLevel(parts: string[]): number {
  return Math.max(0, parts.length - 2);
}

function isApexDomain(parts: string[]): boolean {
  return parts.length === 2;
}

export function matchPattern(
  pattern: string,
  hostname: string,
  pathname: string,
  parts: string[],
): boolean {
  const normalized = normalizePattern(pattern);

  const slashIndex = normalized.indexOf("/");
  const hasPath = slashIndex !== -1;
  // Hosts are case-insensitive (RFC 3986): lowercase the domain literal and the
  // request host once so matching folds case. Wildcards (*, **, .) are
  // unaffected by lowercasing. The path is left untouched (paths are
  // case-sensitive).
  const domainPattern = (
    hasPath ? normalized.slice(0, slashIndex) : normalized
  ).toLowerCase();
  const pathPattern = hasPath ? normalized.slice(slashIndex) : null;

  const lowerHostname = hostname.toLowerCase();
  const lowerParts =
    lowerHostname === hostname ? parts : lowerHostname.split(".");

  const domainMatch = matchDomainPattern(
    domainPattern,
    lowerHostname,
    lowerParts,
  );
  if (!domainMatch) {
    return false;
  }

  if (pathPattern) {
    return pathname === pathPattern || pathname.startsWith(pathPattern + "/");
  }

  return true;
}

function matchDomainPattern(
  pattern: string,
  hostname: string,
  parts: string[],
): boolean {
  if (pattern === hostname) {
    return true;
  }

  if (pattern === "." || pattern === "*") {
    return isApexDomain(parts);
  }

  if (pattern === "**") {
    return true;
  }

  if (pattern === "*.") {
    return getSubdomainLevel(parts) === 1;
  }

  if (pattern === "**.") {
    return getSubdomainLevel(parts) >= 2;
  }

  if (pattern.startsWith("*.") && !pattern.includes(".", 2)) {
    const tld = pattern.slice(2);
    return isApexDomain(parts) && hostname.endsWith("." + tld);
  }

  if (pattern.startsWith("*.")) {
    const baseDomain = pattern.slice(2);
    if (hostname.endsWith("." + baseDomain)) {
      const patternParts = baseDomain.split(".");
      return parts.length === patternParts.length + 1;
    }
    return false;
  }

  if (pattern.startsWith("**.")) {
    const baseDomain = pattern.slice(3);
    if (hostname.endsWith("." + baseDomain)) {
      const patternParts = baseDomain.split(".");
      return parts.length > patternParts.length;
    }
    return false;
  }

  if (pattern.endsWith(".*")) {
    const subdomain = pattern.slice(0, -2);
    if (parts.length === 3 && parts[0] === subdomain) {
      return true;
    }
    return false;
  }

  if (pattern.endsWith(".**")) {
    const subdomain = pattern.slice(0, -3);
    if (parts.length >= 3 && parts[0] === subdomain) {
      return true;
    }
    return false;
  }

  if (pattern.endsWith(".") && !pattern.includes("*")) {
    const subdomain = pattern.slice(0, -1);
    if (parts.length === 3 && parts[0] === subdomain) {
      return true;
    }
    return false;
  }

  return false;
}

export function validatePattern(pattern: string): void {
  if (!pattern || typeof pattern !== "string") {
    throw new InvalidPatternError(
      pattern,
      "Pattern must be a non-empty string",
      { cause: { type: typeof pattern, value: pattern } },
    );
  }

  if (/\s/.test(pattern)) {
    throw new InvalidPatternError(pattern, "contains whitespace", {
      cause: { pattern },
    });
  }
}
