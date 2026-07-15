import type { RscRenderStageEvent } from "../../rsc/render-pipeline.js";
import { isWebSocketUpgradeResponse } from "../../response-utils.js";
import type { ErrorPhase } from "../../types/error-types.js";
import type { InvokeOnErrorContext } from "../error-handling.js";
import type { PhaseSpec } from "../instrument.js";
import type { RevalidationTrace } from "../logging.js";
import type { RequestPlan } from "../request-classification.js";
import {
  getActiveRequestTransaction,
  getRequestIdentity,
  runWithRequestTransaction,
} from "../request-identity.js";
import type { TelemetryEvent } from "../telemetry.js";
import {
  DEVELOPMENT_DIAGNOSTICS_ENABLED,
  getDevelopmentDiagnosticHub,
} from "./hub.js";
import {
  diagnosticSearchNames,
  sanitizeDiagnosticText,
  serializeDiagnosticError,
} from "./redaction.js";
import type { DiagnosticValue } from "./types.js";
import { _getRequestContext } from "../../server/request-context.js";

interface RecordOptions {
  request?: Request;
  requestId?: string;
  transactionId?: string;
  clientCorrelationId?: string | null;
  routerId?: string;
  routeKey?: string;
  segmentId?: string;
  timestamp?: number;
}

const MAX_RETAINED_LOADER_CONSUMERS = 512;

type DiagnosticData = Record<string, unknown> | (() => Record<string, unknown>);

const UINT64_MASK = 0xffff_ffff_ffff_ffffn;
let cacheDiagnosticKey: readonly [bigint, bigint] | undefined;

function rotateLeft64(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & UINT64_MASK;
}

function sipRound(
  state: readonly [bigint, bigint, bigint, bigint],
): [bigint, bigint, bigint, bigint] {
  let [v0, v1, v2, v3] = state;
  v0 = (v0 + v1) & UINT64_MASK;
  v1 = rotateLeft64(v1, 13n) ^ v0;
  v0 = rotateLeft64(v0, 32n);
  v2 = (v2 + v3) & UINT64_MASK;
  v3 = rotateLeft64(v3, 16n) ^ v2;
  v0 = (v0 + v3) & UINT64_MASK;
  v3 = rotateLeft64(v3, 21n) ^ v0;
  v2 = (v2 + v1) & UINT64_MASK;
  v1 = rotateLeft64(v1, 17n) ^ v2;
  v2 = rotateLeft64(v2, 32n);
  return [v0, v1, v2, v3];
}

const cacheIdentityDigest: ((value: string) => string) | undefined =
  DEVELOPMENT_DIAGNOSTICS_ENABLED
    ? function keyedCacheIdentityDigest(value: string): string {
        if (!cacheDiagnosticKey) {
          const random = new Uint32Array(4);
          globalThis.crypto.getRandomValues(random);
          cacheDiagnosticKey = [
            BigInt(random[0]!) | (BigInt(random[1]!) << 32n),
            BigInt(random[2]!) | (BigInt(random[3]!) << 32n),
          ];
        }
        const [key0, key1] = cacheDiagnosticKey;
        let state: [bigint, bigint, bigint, bigint] = [
          key0 ^ 0x736f_6d65_7073_6575n,
          key1 ^ 0x646f_7261_6e64_6f6dn,
          key0 ^ 0x6c79_6765_6e65_7261n,
          key1 ^ 0x7465_6462_7974_6573n,
        ];
        const bytes = new TextEncoder().encode(value);
        const completeBytes = bytes.length - (bytes.length % 8);
        for (let offset = 0; offset < completeBytes; offset += 8) {
          let word = 0n;
          for (let index = 0; index < 8; index++) {
            word |= BigInt(bytes[offset + index]!) << BigInt(index * 8);
          }
          state[3] ^= word;
          state = sipRound(sipRound(state));
          state[0] ^= word;
        }
        let tail = BigInt(bytes.length & 0xff) << 56n;
        for (let index = completeBytes; index < bytes.length; index++) {
          tail |= BigInt(bytes[index]!) << BigInt((index - completeBytes) * 8);
        }
        state[3] ^= tail;
        state = sipRound(sipRound(state));
        state[0] ^= tail;
        state[2] ^= 0xffn;
        state = sipRound(sipRound(sipRound(sipRound(state))));
        const digest = state[0] ^ state[1] ^ state[2] ^ state[3];
        return `cache-${digest.toString(16).padStart(16, "0")}`;
      }
    : undefined;

export function cacheDiagnosticIdentity(value: string): string | null {
  return cacheIdentityDigest?.(value) ?? null;
}

interface RequestDiagnosticOptions {
  echoRequestId?: boolean;
}

const sanitizeValue:
  | ((value: unknown, depth?: number) => DiagnosticValue)
  | undefined = DEVELOPMENT_DIAGNOSTICS_ENABLED
  ? function sanitizeDiagnosticValue(
      value: unknown,
      depth: number = 0,
    ): DiagnosticValue {
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number") return Number.isFinite(value) ? value : 0;
      if (typeof value === "string") return sanitizeDiagnosticText(value);
      if (depth >= 3) return "[truncated]";
      if (Array.isArray(value)) {
        return value
          .slice(0, 128)
          .map((item) => sanitizeDiagnosticValue(item, depth + 1));
      }
      if (value && typeof value === "object") {
        const result: Record<string, DiagnosticValue> = {};
        let count = 0;
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          let item: unknown;
          try {
            item = (value as Record<string, unknown>)[key];
          } catch {
            item = "[unsupported]";
          }
          result[sanitizeDiagnosticText(key, 256)] = sanitizeDiagnosticValue(
            item,
            depth + 1,
          );
          if (++count === 64) break;
        }
        return result;
      }
      return "[unsupported]";
    }
  : undefined;

function recordDiagnostic(
  type: string,
  data: DiagnosticData,
  options: RecordOptions = {},
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  const active = getActiveRequestTransaction();
  const hasExplicitIdentity =
    options.requestId !== undefined &&
    options.transactionId !== undefined &&
    options.routerId !== undefined;
  if (!active?.diagnosticsEnabled && !hasExplicitIdentity) return;
  let requestId: string | undefined;
  let hub: ReturnType<typeof getDevelopmentDiagnosticHub> = null;
  try {
    hub = getDevelopmentDiagnosticHub();
    if (!hub) return;
    const identity = options.request
      ? getRequestIdentity(options.request)
      : undefined;
    requestId = options.requestId ?? identity?.requestId ?? active?.requestId;
    const transactionId =
      options.transactionId ??
      (active?.requestId === requestId ? active?.transactionId : undefined);
    const routerId = options.routerId ?? active?.routerId;
    if (!requestId || !transactionId || !routerId) return;
    hub.record({
      type,
      timestamp: options.timestamp ?? performance.now(),
      requestId,
      transactionId,
      ...((options.clientCorrelationId ?? identity?.clientCorrelationId ?? null)
        ? {
            clientCorrelationId: sanitizeDiagnosticText(
              (options.clientCorrelationId ?? identity?.clientCorrelationId)!,
              128,
            ),
          }
        : {}),
      routerId: sanitizeDiagnosticText(routerId, 512),
      ...(options.routeKey
        ? { routeKey: sanitizeDiagnosticText(options.routeKey, 1_024) }
        : {}),
      ...(options.segmentId
        ? { segmentId: sanitizeDiagnosticText(options.segmentId, 1_024) }
        : {}),
      data: sanitizeValue!(
        typeof data === "function" ? data() : data,
      ) as Record<string, DiagnosticValue>,
    });
  } catch {
    try {
      hub?.noteDroppedEvent(requestId);
    } catch {}
  }
}

export function injectDevelopmentDiagnosticFailureForTesting(): void {
  const unsupported = new Proxy<Record<string, unknown>>(
    {},
    {
      ownKeys(): never {
        throw new Error("injected diagnostic projection failure");
      },
    },
  );
  recordDiagnostic("test.failure", unsupported);
}

export function areDevelopmentDiagnosticsAvailable(): boolean {
  return DEVELOPMENT_DIAGNOSTICS_ENABLED;
}

export function isDevelopmentDiagnosticsEnabled(): boolean {
  return (
    DEVELOPMENT_DIAGNOSTICS_ENABLED &&
    getActiveRequestTransaction()?.diagnosticsEnabled === true
  );
}

export interface DevelopmentDiagnosticLink {
  requestId: string;
  transactionId: string;
  clientCorrelationId: string | null;
  routerId: string;
}

export function getDevelopmentDiagnosticLink(): DevelopmentDiagnosticLink | null {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return null;
  const active = getActiveRequestTransaction();
  if (!active?.diagnosticsEnabled || !active.routerId) return null;
  return {
    requestId: active.requestId,
    transactionId: active.transactionId,
    clientCorrelationId: active.clientCorrelationId,
    routerId: active.routerId,
  };
}

export function runWithDevelopmentDiagnosticsDisabled<T>(
  request: Request,
  routerId: string,
  transaction: string,
  fn: () => T,
): T {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return fn();
  return runWithRequestTransaction(request, transaction, fn, {
    routerId,
    diagnosticsEnabled: false,
  });
}

export function runWithRequestDiagnostics(
  request: Request,
  routerId: string,
  fn: () => Promise<Response>,
  options: RequestDiagnosticOptions = {},
): Promise<Response> {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return fn();
  let identity: ReturnType<typeof getRequestIdentity>;
  let active: ReturnType<typeof getActiveRequestTransaction>;
  try {
    identity = getRequestIdentity(request);
    active = getActiveRequestTransaction();
  } catch {
    return fn();
  }
  if (active?.requestId === identity.requestId && active.diagnosticsEnabled) {
    return fn();
  }

  let entered = false;
  try {
    return runWithRequestTransaction(
      request,
      "request",
      async () => {
        entered = true;
        const startedAt = performance.now();
        try {
          recordRequestStarted(request, new URL(request.url), routerId);
        } catch {}
        try {
          let response = await fn();
          if (
            options.echoRequestId !== false &&
            !isWebSocketUpgradeResponse(response)
          ) {
            try {
              response.headers.set("X-Rango-Request-Id", identity.requestId);
            } catch {
              try {
                const headers = new Headers(response.headers);
                headers.set("X-Rango-Request-Id", identity.requestId);
                response = new Response(response.body, {
                  status: response.status,
                  statusText: response.statusText,
                  headers,
                });
              } catch {
                // Some platform responses cannot be reconstructed. Keep them.
              }
            }
          }
          recordRequestCompleted(
            request,
            response.status,
            performance.now() - startedAt,
          );
          return response;
        } catch (error) {
          if (error instanceof Response) {
            recordRequestCompleted(
              request,
              error.status,
              performance.now() - startedAt,
            );
          } else {
            recordRequestFailed(request, error, performance.now() - startedAt);
          }
          throw error;
        }
      },
      { routerId, diagnosticsEnabled: true },
    );
  } catch (error) {
    if (!entered) return fn();
    throw error;
  }
}

export function recordRequestStarted(
  request: Request,
  url: URL,
  routerId: string,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic(
    "request.started",
    () => ({
      method: request.method,
      searchNames: diagnosticSearchNames(url),
    }),
    { request, routerId },
  );
}

function transportForPlan(plan: RequestPlan, request: Request): string {
  switch (plan.mode) {
    case "full-render":
    case "redirect":
      return "document";
    case "partial-render":
      return request.headers.has("X-Rango-Prefetch")
        ? "prefetch"
        : "navigation";
    case "action":
      return "action";
    case "pe-render":
      return "progressive-enhancement";
    case "loader":
      return "loader-fetch";
    case "response":
      return "response-route";
    case "version-mismatch":
    case "app-switch":
      return "reload";
  }
}

export function recordRequestClassified(
  request: Request,
  plan: RequestPlan,
  routerId: string,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  try {
    const route = "route" in plan ? plan.route : undefined;
    const routeKey = route?.routeKey || undefined;
    const routePattern = routeKey
      ? route?.matched?.entry.routes[routeKey]
      : undefined;
    recordDiagnostic(
      "request.classified",
      () => ({
        mode: plan.mode,
        transport: transportForPlan(plan, request),
        routePattern: routePattern ?? null,
        paramNames: route ? Object.keys(route.params) : [],
        responseType: plan.mode === "response" ? plan.responseType : null,
        actionId: plan.mode === "action" ? plan.actionId : null,
      }),
      { request, routerId, routeKey },
    );
  } catch {}
}

export function recordRequestCompleted(
  request: Request,
  status: number,
  durationMs: number,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic("request.completed", () => ({ status, durationMs }), {
    request,
  });
}

export function recordRequestFailed(
  request: Request,
  error: unknown,
  durationMs: number,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic(
    "request.failed",
    () => ({ error: serializeDiagnosticError(error), durationMs }),
    { request },
  );
}

export interface CacheScopeDiagnostic {
  kind: "explicit" | "inherited" | "implicit-shell" | "disabled" | "prerender";
  ownerType: string | null;
  outcome: "hit" | "miss" | "stale" | "prerendered" | "bypass" | "error";
  reason?: string;
  source: "runtime" | "prerender";
  storeKind: string | null;
  ttl: number | null;
  swr: number | null;
  freshForMs: number | null;
  tags: string[];
  identityDigest: string | null;
  backgroundRevalidationClaimed: boolean;
}

export function recordCacheScopeDiagnostic(
  diagnostic: CacheScopeDiagnostic | (() => CacheScopeDiagnostic),
  segmentId?: string,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic(
    "cache.scope",
    () => {
      const value =
        typeof diagnostic === "function" ? diagnostic() : diagnostic;
      return { ...value, reason: value.reason ?? null };
    },
    { segmentId },
  );
}

export interface LoaderRegistrationDiagnostic {
  loaderId: string;
  registeredBy: string;
  lane: "live" | "baked";
  boundary: "loading" | "none";
  dataCache: "configured" | "disabled" | "none";
}

export function recordLoaderRegistrationDiagnostic(
  diagnostic: LoaderRegistrationDiagnostic,
  segmentId: string,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic("loader.registered", { ...diagnostic }, { segmentId });
}

export function recordLoaderCacheDiagnostic(
  loaderId: string,
  outcome: "hit" | "stale" | "miss" | "bypass",
  options: {
    reason?: string;
    ttl?: number;
    swr?: number;
    backgroundRevalidationRequested?: boolean;
  } = {},
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic("loader.cache", {
    loaderId,
    outcome,
    reason: options.reason ?? null,
    ttl: options.ttl ?? null,
    swr: options.swr ?? null,
    backgroundRevalidationRequested:
      options.backgroundRevalidationRequested ?? false,
  });
}

export function recordLoaderConsumerDiagnostic(
  loaderId: string,
  consumer: {
    kind: "dsl-client" | "handler" | "loader-dependency";
    consumerId: string | null;
    lane: "live" | "baked" | "inherit";
    boundary: "loading" | "none" | "consumer-suspense" | "inherit";
    containerValue: "request" | "capture-generation";
    nestedPromises: "request" | "none";
  },
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  if (
    consumer.kind !== "dsl-client" &&
    consumer.consumerId &&
    consumer.containerValue === "request"
  ) {
    const requestContext = _getRequestContext();
    if (requestContext) {
      const consumers = (requestContext._diagnosticLoaderConsumers ??= []);
      const retainedLoaderId = sanitizeDiagnosticText(loaderId, 256);
      const retainedConsumerId = sanitizeDiagnosticText(
        consumer.consumerId,
        256,
      );
      const key = JSON.stringify([
        retainedLoaderId,
        consumer.kind,
        retainedConsumerId,
      ]);
      const keys = (requestContext._diagnosticLoaderConsumerKeys ??= new Set());
      if (keys.size < MAX_RETAINED_LOADER_CONSUMERS && !keys.has(key)) {
        keys.add(key);
        consumers.push({
          loaderId: retainedLoaderId,
          kind: consumer.kind,
          consumerId: retainedConsumerId,
        });
      }
    }
  }
  recordDiagnostic("loader.consumer", { loaderId, ...consumer });
}

export function recordPprDiagnostic(
  stage: "document" | "capture" | "navigation-replay",
  data: Record<string, unknown>,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic(`ppr.${stage}`, data);
}

export function recordLinkedPprCaptureDiagnostic(
  link: DevelopmentDiagnosticLink,
  data: Record<string, unknown>,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic("ppr.capture", data, link);
}

export function recordReportedError<TEnv>(
  error: unknown,
  phase: ErrorPhase,
  context: InvokeOnErrorContext<TEnv>,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic(
    "error.reported",
    () => ({
      phase,
      error: serializeDiagnosticError(error),
      segmentType: context.segmentType ?? null,
      loaderName: context.loaderName ?? null,
      middlewareId: context.middlewareId ?? null,
      actionId: context.actionId ?? null,
      handledByBoundary: context.handledByBoundary ?? false,
      isPartial: context.isPartial ?? false,
      category:
        typeof context.metadata?.category === "string"
          ? context.metadata.category
          : null,
    }),
    {
      request: context.request,
      routeKey: context.routeKey,
      segmentId: context.segmentId,
    },
  );
}

function phaseData(spec: PhaseSpec): Record<string, unknown> {
  return {
    phase: spec.tracePhase,
    name: spec.spanName,
    label:
      typeof spec.diagnosticLabel === "function"
        ? spec.diagnosticLabel()
        : (spec.diagnosticLabel ?? null),
  };
}

export function recordPhaseStarted(spec: PhaseSpec, timestamp: number): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic("phase.started", () => phaseData(spec), { timestamp });
}

export function recordPhaseCompleted(
  spec: PhaseSpec,
  timestamp: number,
  durationMs: number,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic(
    "phase.completed",
    () => ({ ...phaseData(spec), durationMs }),
    { timestamp },
  );
}

export function recordPhaseFailed(
  spec: PhaseSpec,
  timestamp: number,
  durationMs: number,
  error: unknown,
): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic(
    "phase.failed",
    () => ({
      ...phaseData(spec),
      durationMs,
      error: serializeDiagnosticError(error),
    }),
    { timestamp },
  );
}

export function recordTelemetryDiagnostic(event: TelemetryEvent): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  const options: RecordOptions = {
    requestId: event.requestId,
    timestamp: event.timestamp,
  };
  switch (event.type) {
    case "request.start":
      recordDiagnostic(
        "match.started",
        {
          method: event.method,
          transaction: event.transaction,
          isPartial: event.isPartial,
        },
        options,
      );
      break;
    case "request.end":
      recordDiagnostic(
        "match.completed",
        {
          method: event.method,
          transaction: event.transaction,
          durationMs: event.durationMs,
          segmentCount: event.segmentCount,
          cacheHit: event.cacheHit,
          status: event.status ?? null,
        },
        options,
      );
      break;
    case "request.error":
      recordDiagnostic(
        "match.failed",
        {
          method: event.method,
          transaction: event.transaction,
          phase: event.phase,
          durationMs: event.durationMs,
          error: serializeDiagnosticError(event.error),
        },
        options,
      );
      break;
    case "cache.decision":
      recordDiagnostic(
        "cache.decision",
        {
          hit: event.hit,
          shouldRevalidate: event.shouldRevalidate,
          source: event.source ?? null,
          segments: event.segments ?? [],
        },
        { ...options, routeKey: event.routeKey },
      );
      break;
    case "revalidation.decision":
      recordDiagnostic(
        "revalidation.decision",
        { shouldRevalidate: event.shouldRevalidate },
        {
          ...options,
          routeKey: event.routeKey,
          segmentId: event.segmentId,
        },
      );
      break;
    case "request.timeout":
      recordDiagnostic(
        "request.timeout",
        {
          phase: event.phase,
          durationMs: event.durationMs,
          actionId: event.actionId ?? null,
          customHandler: event.customHandler,
          render: event.render ?? null,
        },
        { ...options, routeKey: event.routeKey },
      );
      break;
    case "request.origin-rejected":
      recordDiagnostic(
        "request.origin-rejected",
        { method: event.method, phase: event.phase },
        options,
      );
      break;
    case "loader.start":
    case "loader.end":
    case "loader.error":
    case "handler.error":
      // Actual loader execution phases and invokeOnError own these diagnostics.
      break;
  }
}

export function recordRevalidationTrace(trace: RevalidationTrace): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  const safeUrl = (value: string): URL | null => {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  };
  recordDiagnostic(
    "revalidation.trace",
    () => {
      const previous = safeUrl(trace.meta.prevUrl);
      const next = safeUrl(trace.meta.nextUrl);
      return {
        method: trace.meta.method,
        routeKey: trace.meta.routeKey,
        isAction: trace.meta.isAction,
        stale: trace.meta.stale ?? false,
        actionId: trace.meta.actionId ?? null,
        pathChanged:
          previous !== null && next !== null
            ? previous.pathname !== next.pathname
            : false,
        previousSearchNames: previous ? diagnosticSearchNames(previous) : [],
        nextSearchNames: next ? diagnosticSearchNames(next) : [],
        entriesTruncated: trace.entries.length > 128,
        entries: trace.entries.slice(0, 128).map((entry) => ({
          segmentId: entry.segmentId,
          segmentType: entry.segmentType,
          belongsToRoute: entry.belongsToRoute,
          source: entry.source,
          defaultShouldRevalidate: entry.defaultShouldRevalidate,
          finalShouldRevalidate: entry.finalShouldRevalidate,
          reason: entry.reason,
          customRevalidators: entry.customRevalidators ?? 0,
        })),
      };
    },
    { routeKey: trace.meta.routeKey },
  );
}

export function recordRenderStageEvent(event: RscRenderStageEvent): void {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  recordDiagnostic(
    `render.${event.type}`,
    () => ({
      mode: event.context.mode,
      phase: event.context.phase,
      progress: event.context.progress,
      actionId: event.context.actionId ?? null,
      ...(event.type === "stage:complete" || event.type === "stage:error"
        ? { durationMs: event.durationMs }
        : {}),
      ...(event.type === "stage:error"
        ? { error: serializeDiagnosticError(event.error) }
        : {}),
    }),
    { routeKey: event.context.routeKey },
  );
}
