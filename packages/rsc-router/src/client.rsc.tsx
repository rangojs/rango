/**
 * RSC-environment version of client exports
 *
 * This file is used when importing "rsc-router/client" from RSC (server components).
 * It re-exports the server's createLoader so that loader definitions work in both
 * environments with the same import.
 *
 * The bundler uses the "react-server" export condition to select this file
 * in RSC context, while the regular client.tsx is used in client components.
 */

// Re-export everything from client.tsx (Outlet, useLoader, etc.)
// These are safe to use in RSC context
export {
  Outlet,
  ParallelOutlet,
  OutletProvider,
  useOutlet,
  useLoader,
  useLoaderData,
} from "./client.js";

// Re-export the server's createLoader for RSC context
// This version includes the actual loader function
export { createLoader } from "./route-definition.js";
