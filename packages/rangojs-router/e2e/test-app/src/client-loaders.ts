import { createLoader, createClientLoader, createIsomorphicLoader } from "@rangojs/router";

// ============================================================================
// Client & Isomorphic Loader Definitions
// Split into a separate file so client component imports don't pull in
// server-side implementation details from loaders.ts.
// ============================================================================

/**
 * Client-only loader - reads from a simulated client-side source.
 * Never runs on the server. SSR shows the loading skeleton.
 */
export const ClientThemeLoader = createClientLoader(async () => {
  // In a real app, this could read localStorage, cookies, etc.
  return {
    theme: "dark",
    source: "client" as const,
    timestamp: new Date().toISOString(),
  };
});

export type ClientThemeData = {
  theme: string;
  source: "client";
  timestamp: string;
};

/**
 * Counter for isomorphic loader server invocations
 */
let isomorphicServerCount = 0;

/**
 * Isomorphic loader - server fn runs during SSR, client fn runs during SPA navigation.
 * The server fn returns source: "server", the client fn returns source: "client".
 */
export const IsomorphicCartLoader = createIsomorphicLoader(
  async () => {
    // Server fn: runs during SSR document requests
    isomorphicServerCount++;
    return {
      items: ["item-a", "item-b"],
      total: 2,
      source: "server" as "server" | "client",
      count: isomorphicServerCount,
      timestamp: new Date().toISOString(),
    };
  },
  async () => {
    // Client fn: runs during SPA navigation in the browser
    return {
      items: ["item-a", "item-b", "item-c"],
      total: 3,
      source: "client" as "server" | "client",
      count: -1, // Client doesn't track server count
      timestamp: new Date().toISOString(),
    };
  },
);

export type IsomorphicCartData = {
  items: string[];
  total: number;
  source: "server" | "client";
  count: number;
  timestamp: string;
};

/**
 * Standard server loader alongside client loaders (for mixed-loader test).
 */
let serverOnlyCount = 0;
export const ServerOnlyTestLoader = createLoader(async () => {
  serverOnlyCount++;
  return {
    message: "server-only-data",
    count: serverOnlyCount,
    source: "server" as const,
  };
});

export type ServerOnlyTestData = {
  message: string;
  count: number;
  source: "server";
};
