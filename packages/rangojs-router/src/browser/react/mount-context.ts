"use client";

import { createContext, createElement, type Context, type ReactNode } from "react";

/**
 * Context for the current include() mount path.
 *
 * Each include() wraps its subtree with a MountContext.Provider
 * carrying the URL prefix. Nested includes override the context,
 * so useMount() returns the nearest mount path.
 *
 * Default value "/" means root-level (no include wrapping).
 */
export const MountContext: Context<string> = createContext<string>("/");

/**
 * Provider wrapper for MountContext.
 *
 * RSC server components cannot use MountContext.Provider directly because
 * .Provider is a property on the context object, not a named export.
 * Client reference proxies on the RSC server return undefined for property
 * access. This wrapper is a proper "use client" export that RSC can reference.
 */
export function MountContextProvider({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  return createElement(MountContext, { value }, children);
}
