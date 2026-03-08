"use client";

/**
 * Context for CSP nonce propagation to client components during SSR.
 *
 * The SSR renderer wraps the tree with NonceContext.Provider so that
 * client components (e.g. MetaTags) can apply nonces to inline scripts.
 * On the browser side, no provider is needed — the default undefined
 * is correct since CSP nonces are a server-side HTML concern.
 */

import { createContext, useContext, type Context } from "react";

export const NonceContext: Context<string | undefined> = createContext<
  string | undefined
>(undefined);

/**
 * Read the CSP nonce during SSR. Returns undefined on the client.
 */
export function useNonce(): string | undefined {
  return useContext(NonceContext);
}
