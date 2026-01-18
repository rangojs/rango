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

  /**
   * Nonce for Content Security Policy (CSP)
   */
  nonce?: string;
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
 * Nonce provider function type.
 * Can return a nonce string, or true to auto-generate one.
 */
export type NonceProvider<TEnv = unknown> = (
  request: Request,
  env: TEnv
) => string | true | Promise<string | true>;

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

  /**
   * Nonce provider for Content Security Policy (CSP).
   *
   * Can be:
   * - A function that returns a nonce string
   * - A function that returns `true` to auto-generate a nonce
   * - Undefined to disable nonce (default)
   *
   * The nonce will be applied to inline scripts injected by the RSC payload.
   * It's also available to middleware via `ctx.get('nonce')`.
   *
   * @example Auto-generate nonce
   * ```tsx
   * createRSCHandler({
   *   router,
   *   nonce: () => true,
   * });
   * ```
   *
   * @example Custom nonce from request context
   * ```tsx
   * createRSCHandler({
   *   router,
   *   nonce: (request, env) => env.nonce,
   * });
   * ```
   */
  nonce?: NonceProvider<TEnv>;
}
