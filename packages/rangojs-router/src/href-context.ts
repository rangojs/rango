"use client";

/**
 * Href Context for route name resolution
 *
 * This module is marked "use client" so it can be imported by both:
 * - Server (segment-system): Gets a client reference for createElement
 * - Client (useHref): Uses the actual context for useContext
 *
 * The context stores:
 * - routeMap: Map of route names to URL patterns
 * - routeName: Current matched route name (for local name resolution)
 */
import { createContext, type Context } from "react";

/**
 * Context value for href resolution
 */
export interface HrefContextValue {
  /** Route map: route name -> URL pattern */
  routeMap: Record<string, string>;
  /** Current matched route name (includes name prefix from include()) */
  routeName?: string;
}

/**
 * Context for href resolution (route map and current route name)
 *
 * On the server: Populated by renderSegments() via HrefContext.Provider
 * On the client: Populated by NavigationProvider from RSC metadata
 */
export const HrefContext: Context<HrefContextValue | null> =
  createContext<HrefContextValue | null>(null);
