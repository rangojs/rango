import type { ReactNode } from "react";
import { sanitizeError } from "../errors";
import type { ErrorInfo, ErrorPhase, MatchResult } from "../types";
import type {
  EntryData,
  InterceptEntry,
  InterceptSelectorContext,
} from "../server/context";
import type { MatchApiDeps } from "./types.js";
import type { RouterContext } from "./router-context.js";
import { runWithRouterContext } from "./router-context.js";
import {
  type ActionContext,
  type MatchContext,
  createPipelineState,
} from "./match-context.js";
import { createMatchPartialPipeline } from "./match-pipelines.js";
import { collectMatchResult } from "./match-result.js";
import {
  createMatchContextForFull as _createMatchContextForFull,
  createMatchContextForPartial as _createMatchContextForPartial,
  matchError as _matchError,
} from "./match-api.js";
import { previewMatch as _previewMatch } from "./preview-match.js";
import { runWithRouterLogContext, withRouterLogScope } from "./logging.js";
import type { ErrorBoundaryHandler, NotFoundBoundaryHandler } from "../types";
import type { MiddlewareFn } from "./middleware.js";

export interface MatchHandlerDeps<TEnv = any> {
  buildRouterContext: () => RouterContext<TEnv>;
  callOnError: (error: unknown, phase: ErrorPhase, context: any) => void;
  matchApiDeps: MatchApiDeps<TEnv>;
  defaultErrorBoundary: ReactNode | ErrorBoundaryHandler | undefined;
  findMatch: (pathname: string, ms?: any) => any;
  findInterceptForRoute: (
    routeKey: string,
    parentEntry: EntryData | null,
    selectorContext: InterceptSelectorContext | null,
    isAction: boolean,
  ) => { intercept: InterceptEntry; entry: EntryData } | null;
}

export interface MatchHandlers<TEnv = any> {
  match: (request: Request, env: TEnv) => Promise<MatchResult>;
  matchPartial: (
    request: Request,
    context: TEnv,
    actionContext?: ActionContext,
  ) => Promise<MatchResult | null>;
  matchError: (
    request: Request,
    _context: TEnv,
    error: unknown,
    segmentType?: ErrorInfo["segmentType"],
  ) => Promise<MatchResult | null>;
  previewMatch: (
    request: Request,
    _context: TEnv,
  ) => Promise<{
    routeMiddleware?: Array<{
      handler: MiddlewareFn;
      params: Record<string, string>;
    }>;
    responseType?: string;
    handler?: Function;
    params?: Record<string, string>;
    negotiated?: boolean;
    manifestEntry?: EntryData;
  } | null>;
  createMatchContextForFull: (
    request: Request,
    env: TEnv,
  ) => Promise<MatchContext<TEnv> | { type: "redirect"; redirectUrl: string }>;
  createMatchContextForPartial: (
    request: Request,
    env: TEnv,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    },
  ) => Promise<MatchContext<TEnv> | null>;
}

/**
 * Create match handler functions bound to router closure state.
 * These are the main request-handling entry points for SSR, navigation,
 * error recovery, and preview matching.
 */
export function createMatchHandlers<TEnv = any>(
  deps: MatchHandlerDeps<TEnv>,
): MatchHandlers<TEnv> {
  const {
    buildRouterContext,
    callOnError,
    matchApiDeps,
    defaultErrorBoundary,
    findInterceptForRoute,
  } = deps;

  async function createMatchContextForFull(
    request: Request,
    env: TEnv,
  ): Promise<MatchContext<TEnv> | { type: "redirect"; redirectUrl: string }> {
    return _createMatchContextForFull(
      request,
      env,
      matchApiDeps,
      findInterceptForRoute,
    );
  }

  async function createMatchContextForPartial(
    request: Request,
    env: TEnv,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    },
  ): Promise<MatchContext<TEnv> | null> {
    return _createMatchContextForPartial(
      request,
      env,
      matchApiDeps,
      findInterceptForRoute,
      actionContext,
    );
  }

  /**
   * Match request and return segments (document/SSR requests)
   *
   * Uses generator middleware pipeline for clean separation of concerns:
   * - cache-lookup: Check cache first
   * - segment-resolution: Resolve segments on cache miss
   * - cache-store: Store results in cache
   * - background-revalidation: SWR revalidation
   */
  async function match(request: Request, env: TEnv): Promise<MatchResult> {
    return runWithRouterLogContext({ request, transaction: "match" }, () =>
      runWithRouterContext(buildRouterContext(), async () =>
        withRouterLogScope("match", async () => {
          const result = await createMatchContextForFull(request, env);

          // Handle redirect case
          if ("type" in result && result.type === "redirect") {
            return {
              segments: [],
              matched: [],
              diff: [],
              params: {},
              redirect: result.redirectUrl,
            };
          }

          const ctx = result as MatchContext<TEnv>;

          try {
            const state = createPipelineState();
            const pipeline = createMatchPartialPipeline(ctx, state);
            return await collectMatchResult(pipeline, ctx, state);
          } catch (error) {
            if (error instanceof Response) throw error;
            // Report unhandled errors during full match pipeline
            callOnError(error, "routing", {
              request,
              url: ctx.url,
              env,
              isPartial: false,
              handledByBoundary: false,
            });
            throw sanitizeError(error);
          }
        }),
      ),
    );
  }

  async function matchError(
    request: Request,
    _context: TEnv,
    error: unknown,
    segmentType: ErrorInfo["segmentType"] = "route",
  ): Promise<MatchResult | null> {
    return runWithRouterLogContext({ request, transaction: "matchError" }, () =>
      withRouterLogScope("matchError", () =>
        _matchError(
          request,
          _context,
          error,
          matchApiDeps,
          defaultErrorBoundary,
          segmentType,
        ),
      ),
    );
  }

  /**
   * Match partial request with revalidation
   *
   * Uses generator middleware pipeline for clean separation of concerns:
   * - cache-lookup: Check cache first
   * - segment-resolution: Resolve segments on cache miss
   * - intercept-resolution: Handle intercept routes
   * - cache-store: Store results in cache
   * - background-revalidation: SWR revalidation
   */
  async function matchPartial(
    request: Request,
    context: TEnv,
    actionContext?: ActionContext,
  ): Promise<MatchResult | null> {
    return runWithRouterLogContext(
      { request, transaction: "matchPartial" },
      () =>
        runWithRouterContext(buildRouterContext(), async () =>
          withRouterLogScope("matchPartial", async () => {
            const ctx = await createMatchContextForPartial(
              request,
              context,
              actionContext,
            );
            if (!ctx) return null;

            try {
              const state = createPipelineState();
              const pipeline = createMatchPartialPipeline(ctx, state);
              return await collectMatchResult(pipeline, ctx, state);
            } catch (error) {
              if (error instanceof Response) throw error;
              // Report unhandled errors during partial match pipeline
              callOnError(error, actionContext ? "action" : "revalidation", {
                request,
                url: ctx.url,
                env: context,
                actionId: actionContext?.actionId,
                isPartial: true,
                handledByBoundary: false,
              });
              throw sanitizeError(error);
            }
          }),
        ),
    );
  }

  async function previewMatch(
    request: Request,
    _context: TEnv,
  ): ReturnType<typeof _previewMatch> {
    return _previewMatch(request, _context, { findMatch: deps.findMatch });
  }

  return {
    match: match,
    matchPartial: matchPartial,
    matchError: matchError,
    previewMatch: previewMatch,
    createMatchContextForFull: createMatchContextForFull,
    createMatchContextForPartial: createMatchContextForPartial,
  };
}
