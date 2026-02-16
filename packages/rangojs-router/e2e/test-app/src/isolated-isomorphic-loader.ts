import { createIsomorphicLoader } from "@rangojs/router";

// This file ONLY exports an isomorphic loader (export-only file).
// Tests that the Vite plugin does not stub the client function
// registration when the file has no other exports.
export const IsolatedIsomorphicLoader = createIsomorphicLoader(
  async () => {
    return {
      value: "from-server",
      source: "server" as "server" | "client",
      timestamp: new Date().toISOString(),
    };
  },
  async () => {
    return {
      value: "from-client",
      source: "client" as "server" | "client",
      timestamp: new Date().toISOString(),
    };
  },
);
