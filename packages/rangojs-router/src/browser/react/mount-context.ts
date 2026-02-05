"use client";

import { createContext, type Context } from "react";

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
