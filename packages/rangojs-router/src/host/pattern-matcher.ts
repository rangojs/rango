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
 */

import { InvalidPatternError } from './errors.js';

/**
 * Normalize a pattern by removing trailing slashes from paths
 */
export function normalizePattern(pattern: string): string {
  // If pattern has a path component, remove trailing slash
  const slashIndex = pattern.indexOf('/');
  if (slashIndex !== -1) {
    const domain = pattern.slice(0, slashIndex);
    const path = pattern.slice(slashIndex).replace(/\/$/, '');
    return domain + path;
  }
  return pattern;
}

/**
 * Parse hostname and path from request URL
 */
export function parseRequest(request: Request): {
  hostname: string;
  pathname: string;
  parts: string[];
} {
  const url = new URL(request.url);
  const hostname = url.hostname;
  const pathname = url.pathname;
  const parts = hostname.split('.');

  return { hostname, pathname, parts };
}

/**
 * Count subdomain levels (0 for apex, 1+ for subdomains)
 */
function getSubdomainLevel(parts: string[]): number {
  // Apex domain has 2 parts (example.com)
  // Single subdomain has 3 parts (www.example.com)
  // Multi-level has 4+ parts (a.b.example.com)
  return Math.max(0, parts.length - 2);
}

/**
 * Check if hostname is an apex domain (no subdomains)
 */
function isApexDomain(parts: string[]): boolean {
  return parts.length === 2;
}

/**
 * Match a single pattern against hostname and path
 */
export function matchPattern(
  pattern: string,
  hostname: string,
  pathname: string,
  parts: string[]
): boolean {
  const normalized = normalizePattern(pattern);

  // Check if pattern has path component
  const slashIndex = normalized.indexOf('/');
  const hasPath = slashIndex !== -1;
  const domainPattern = hasPath ? normalized.slice(0, slashIndex) : normalized;
  const pathPattern = hasPath ? normalized.slice(slashIndex) : null;

  // First match domain
  const domainMatch = matchDomainPattern(domainPattern, hostname, parts);
  if (!domainMatch) {
    return false;
  }

  // Then match path (prefix match)
  if (pathPattern) {
    return pathname === pathPattern || pathname.startsWith(pathPattern + '/');
  }

  return true;
}

/**
 * Match domain pattern against hostname
 */
function matchDomainPattern(
  pattern: string,
  hostname: string,
  parts: string[]
): boolean {
  // Exact match
  if (pattern === hostname) {
    return true;
  }

  // `.` or `*` - any apex domain
  if (pattern === '.' || pattern === '*') {
    return isApexDomain(parts);
  }

  // `**` - any domain (apex + all subdomains)
  if (pattern === '**') {
    return true;
  }

  // `*.` - any single-level subdomain
  if (pattern === '*.') {
    return getSubdomainLevel(parts) === 1;
  }

  // `**.` - any multi-level subdomain (2+ levels)
  if (pattern === '**.') {
    return getSubdomainLevel(parts) >= 2;
  }

  // `*.tld` - any apex domain with specific TLD (e.g., *.com)
  if (pattern.startsWith('*.') && !pattern.includes('.', 2)) {
    const tld = pattern.slice(2);
    return isApexDomain(parts) && hostname.endsWith('.' + tld);
  }

  // `*.example.com` - single subdomain of specific domain
  if (pattern.startsWith('*.')) {
    const baseDomain = pattern.slice(2);
    if (hostname.endsWith('.' + baseDomain)) {
      // Count parts: if pattern is *.example.com (3 parts),
      // hostname should have exactly 4 parts (www.example.com)
      const patternParts = baseDomain.split('.');
      return parts.length === patternParts.length + 1;
    }
    return false;
  }

  // `**.example.com` - any depth subdomain of specific domain
  if (pattern.startsWith('**.')) {
    const baseDomain = pattern.slice(3);
    if (hostname.endsWith('.' + baseDomain)) {
      const patternParts = baseDomain.split('.');
      // Must have more parts than the base domain (i.e., has subdomains)
      return parts.length > patternParts.length;
    }
    return false;
  }

  // `subdomain.*` - specific subdomain of any apex domain
  // e.g., admin.* matches admin.example.com, admin.google.com
  if (pattern.endsWith('.*')) {
    const subdomain = pattern.slice(0, -2);
    // Must be single-level subdomain (3 parts total)
    if (parts.length === 3 && parts[0] === subdomain) {
      return true;
    }
    return false;
  }

  // `subdomain.**` - specific subdomain of any domain (including multi-level)
  // e.g., admin.** matches admin.example.com, admin.sub.example.com
  if (pattern.endsWith('.**')) {
    const subdomain = pattern.slice(0, -3);
    if (parts.length >= 3 && parts[0] === subdomain) {
      return true;
    }
    return false;
  }

  // `subdomain.` - specific subdomain of any apex domain (no wildcard)
  // e.g., admin. matches admin.example.com, admin.google.com
  if (pattern.endsWith('.') && !pattern.includes('*')) {
    const subdomain = pattern.slice(0, -1);
    // Must be exactly 3 parts (subdomain.domain.tld)
    if (parts.length === 3 && parts[0] === subdomain) {
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Validate pattern format
 */
export function validatePattern(pattern: string): void {
  if (!pattern || typeof pattern !== 'string') {
    throw new InvalidPatternError(
      pattern,
      'Pattern must be a non-empty string',
      { cause: { type: typeof pattern, value: pattern } }
    );
  }

  // Check for invalid characters (spaces, etc.)
  if (/\s/.test(pattern)) {
    throw new InvalidPatternError(pattern, 'contains whitespace', {
      cause: { pattern },
    });
  }

  // Additional validation can be added here
}
