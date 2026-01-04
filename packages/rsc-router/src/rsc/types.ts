/**
 * RSC Handler Types
 *
 * Type definitions for the RSC request handler, payload structures,
 * and SSR integration.
 */

import type { ResolvedSegment, SlotState } from "../types.js";
import type { HandleData } from "../server/handle-store.js";
import type { RSCRouter } from "../router.js";

/**
 * RSC payload sent to the client
 */
export interface RscPayload {
  root: React.ReactNode | Promise<React.ReactNode>;
  metadata?: {
    pathname: string;
    segments: ResolvedSegment[];
    isPartial?: boolean;
    isError?: boolean;
    matched?: string[];
    diff?: string[];
    slots?: Record<string, SlotState>;
    /** Root layout component for browser-side re-renders (client component reference) */
    rootLayout?: React.ComponentType<{ children: React.ReactNode }>;
    /** Handle data accumulated across route segments (async generator that yields on each push) */
    handles?: AsyncGenerator<HandleData, void, unknown>;
  };
  returnValue?: { ok: boolean; data: unknown };
  formState?: unknown;
}

/**
 * React form state type for useActionState progressive enhancement
 */
export type ReactFormState = unknown;

/**
 * RSC dependencies from @vitejs/plugin-rsc/rsc
 */
export interface RSCDependencies {
  /**
   * renderToReadableStream from @vitejs/plugin-rsc/rsc
   */
  renderToReadableStream: <T>(
    payload: T,
    options?: { temporaryReferences?: unknown }
  ) => ReadableStream<Uint8Array>;

  /**
   * decodeReply from @vitejs/plugin-rsc/rsc
   */
  decodeReply: (
    body: FormData | string,
    options?: { temporaryReferences?: unknown }
  ) => Promise<unknown[]>;

  /**
   * createTemporaryReferenceSet from @vitejs/plugin-rsc/rsc
   */
  createTemporaryReferenceSet: () => unknown;

  /**
   * loadServerAction from @vitejs/plugin-rsc/rsc
   */
  loadServerAction: (actionId: string) => Promise<Function>;

  /**
   * decodeAction from @vitejs/plugin-rsc/rsc
   * Decodes a FormData into a bound action function (for useActionState forms)
   */
  decodeAction: (body: FormData) => Promise<() => Promise<unknown>>;

  /**
   * decodeFormState from @vitejs/plugin-rsc/rsc
   * Decodes the action result into a ReactFormState for useActionState progressive enhancement
   */
  decodeFormState: (
    actionResult: unknown,
    body: FormData
  ) => Promise<ReactFormState | null>;
}

/**
 * Options for SSR HTML rendering
 */
export interface SSRRenderOptions {
  /**
   * Form state for useActionState progressive enhancement.
   * This is the result of decodeFormState() and should be passed to
   * react-dom's renderToReadableStream to enable useActionState to
   * receive the action result during SSR.
   */
  formState?: ReactFormState | null;
}

/**
 * SSR module interface for HTML rendering
 */
export interface SSRModule {
  renderHTML: (
    rscStream: ReadableStream<Uint8Array>,
    options?: SSRRenderOptions
  ) => Promise<ReadableStream<Uint8Array>>;
}

/**
 * Function to load SSR module dynamically
 */
export type LoadSSRModule = () => Promise<SSRModule>;

/**
 * Options for creating an RSC handler
 */
export interface CreateRSCHandlerOptions<TEnv = unknown> {
  /**
   * The RSC router instance
   */
  router: RSCRouter<TEnv>;

  /**
   * RSC dependencies from @vitejs/plugin-rsc/rsc.
   * Defaults to the exports from @vitejs/plugin-rsc/rsc.
   */
  deps?: RSCDependencies;

  /**
   * Function to load the SSR module for HTML rendering.
   * Defaults to: () => import.meta.viteRsc.loadModule("ssr", "index")
   */
  loadSSRModule?: LoadSSRModule;
}
