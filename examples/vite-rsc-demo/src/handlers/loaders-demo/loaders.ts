import { createLoader } from "rsc-router";
import {
  usersStore,
  getStats,
  getLoaderCallCount,
  getFetchableLoaderCallCount,
  type User,
  type Stats,
} from "./data.js";

// Export types for use in components
export type { User, Stats };

/**
 * UsersLoader - Standard loader for SSR/navigation
 * Data is loaded during SSR and navigation, accessed via useLoader()
 *
 * Use case: Initial page data that should be available immediately
 */
export const UsersLoader = createLoader("loaders-demo-users", async (_ctx) => {
  "use server";

  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 300));

  const callCount = getLoaderCallCount();

  return {
    users: [...usersStore],
    loadedAt: new Date().toISOString(),
    callCount,
    source: "SSR/Navigation" as const,
  };
});

export type UsersLoaderData = {
  users: User[];
  loadedAt: string;
  callCount: number;
  source: "SSR/Navigation";
};

/**
 * StatsLoader - Fetchable loader for on-demand client fetching
 * Data is fetched via useFetchLoader() when the client needs it
 *
 * The third argument `true` makes this loader fetchable via GET requests.
 * The loader ID is hashed in production builds to avoid exposing file paths.
 *
 * Use case: Data that should be fetched on-demand, not during initial load
 */
export const StatsLoader = createLoader(
  "loaders-demo-stats",
  async (_ctx) => {
    "use server";

    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 500));

    const callCount = getFetchableLoaderCallCount();
    const stats = getStats();

    return {
      stats,
      loadedAt: new Date().toISOString(),
      callCount,
      source: "Client Fetch (GET)" as const,
    };
  },
  true // Enable fetchable - this loader can be called via useFetchLoader()
);

export type StatsLoaderData = {
  stats: Stats;
  loadedAt: string;
  callCount: number;
  source: "Client Fetch (GET)";
};

/**
 * UserSearchLoader - Fetchable loader with parameters
 * Demonstrates passing params from client to server loader
 *
 * Use case: Search/filter functionality triggered by user interaction
 */
export const UserSearchLoader = createLoader(
  "loaders-demo-user-search",
  async (ctx) => {
    "use server";

    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Get search query from params (passed from client via useFetchLoader)
    const query = (ctx.params.query as string) || "";
    const roleFilter = ctx.params.role as string | undefined;

    let results = [...usersStore];

    // Filter by query (name or email)
    if (query) {
      const lowerQuery = query.toLowerCase();
      results = results.filter(
        (user) =>
          user.name.toLowerCase().includes(lowerQuery) ||
          user.email.toLowerCase().includes(lowerQuery)
      );
    }

    // Filter by role
    if (roleFilter && roleFilter !== "all") {
      results = results.filter((user) => user.role === roleFilter);
    }

    return {
      results,
      query,
      roleFilter: roleFilter || "all",
      totalMatches: results.length,
      searchedAt: new Date().toISOString(),
    };
  },
  true // Enable fetchable
);

export type UserSearchLoaderData = {
  results: User[];
  query: string;
  roleFilter: string;
  totalMatches: number;
  searchedAt: string;
};
