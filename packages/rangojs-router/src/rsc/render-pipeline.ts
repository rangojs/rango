import { appendMetric } from "../router/metrics.js";
import type { MetricsStore } from "../server/context.js";
import { observePhase, PHASES } from "../router/instrument.js";
import { _getRequestContext } from "../server/request-context.js";
import type { TraceSpan } from "../router/tracing.js";
import type { RenderMode, RenderPhase } from "../router/timeout.js";
import type { HandlerContext } from "./handler-context.js";
import { createResponseWithMergedHeaders } from "./helpers.js";
import type { RscPayload } from "./types.js";

// Canonical unions live in router/timeout.ts (the dependency-free leaf); these
// aliases keep the render-pipeline names stable for existing importers.
export type RscRenderMode = RenderMode;

export type RscRenderPhase = RenderPhase;

export interface RscRenderStageProgress {
  completed: number;
  total: number;
}

export interface RscRenderStageContext {
  mode: RscRenderMode;
  phase: RscRenderPhase;
  pathname: string;
  progress: RscRenderStageProgress;
  startedAt: number;
  phaseStartedAt: number;
  routeKey?: string;
  actionId?: string;
}

export type RscRenderStageEvent =
  | { type: "stage:start"; context: RscRenderStageContext }
  | {
      type: "stage:complete";
      context: RscRenderStageContext;
      durationMs: number;
    }
  | {
      type: "stage:error";
      context: RscRenderStageContext;
      durationMs: number;
      error: unknown;
    };

export interface RscRenderStageTracking {
  mode?: RscRenderMode;
  routeKey?: string;
  actionId?: string;
  onEvent?: (event: RscRenderStageEvent) => void;
  /** Whole-render span receiving low-cardinality current/error phase attrs. */
  span?: TraceSpan;
}

type RscRenderContext<TEnv> = Pick<
  HandlerContext<TEnv>,
  "renderToReadableStream" | "callOnError" | "devDiscoveryEpoch"
>;

export interface RscRenderInput<TEnv> {
  ctx: RscRenderContext<TEnv>;
  request: Request;
  url: URL;
  env: TEnv;
  payload: RscPayload;
  init: ResponseInit;
  temporaryReferences?: unknown;
  recordSerializeMetric?: boolean;
  tracking?: RscRenderStageTracking;
}

export interface RscFlightStageInput<TEnv> {
  ctx: RscRenderContext<TEnv>;
  request: Request;
  url: URL;
  env: TEnv;
  payload: RscPayload;
  temporaryReferences?: unknown;
  recordSerializeMetric?: boolean;
  tracking?: RscRenderStageTracking;
}

export interface RscFlightStage {
  type: "flight";
  payload: RscPayload;
  stream: ReadableStream<Uint8Array>;
  init: ResponseInit;
}

export interface RscPreparedHtmlRender {
  render: () => BodyInit | null | Promise<BodyInit | null>;
  init?: ResponseInit;
}

export interface RscRenderOptions {
  html?: (
    flight: RscFlightStage,
  ) => RscPreparedHtmlRender | Promise<RscPreparedHtmlRender>;
}

interface RscFlightCommand<TEnv> {
  type: "flight";
  execute: () => RscFlightStage;
  recordSerializeMetric: boolean;
}

interface RscHtmlCommand {
  type: "html";
  prepare: () => RscPreparedHtmlRender | Promise<RscPreparedHtmlRender>;
}

interface RscResponseCommand {
  type: "response";
  execute: () => Response;
}

export type RscRenderCommand<TEnv> =
  | RscFlightCommand<TEnv>
  | RscHtmlCommand
  | RscResponseCommand;

export type RscRenderCommandResult =
  | { type: "flight"; value: RscFlightStage }
  | { type: "html"; value: RscHtmlResult }
  | { type: "response"; value: Response };

interface RscHtmlResult {
  body: BodyInit | null;
  init?: ResponseInit;
}

export interface RscRenderDriverOptions {
  url: URL;
  tracking?: RscRenderStageTracking;
  /**
   * The plan's command sequence. Required (not defaulted): the driver reports
   * `total` from its length, and a wrong/absent list made progress read
   * `completed > total`. Callers of createRscRenderPlan pass rscRenderPlanPhases.
   */
  phases: readonly RscRenderPhase[];
}

type RscRenderPlan<TEnv> = Generator<
  RscRenderCommand<TEnv>,
  Response | undefined,
  RscRenderCommandResult
>;

function createFlightStage<TEnv>(
  input: RscFlightStageInput<TEnv>,
  init: ResponseInit,
): RscFlightStage {
  if (input.ctx.devDiscoveryEpoch !== undefined && input.payload.metadata) {
    input.payload.metadata.devDiscoveryEpoch = input.ctx.devDiscoveryEpoch;
  }
  const stream = input.ctx.renderToReadableStream<RscPayload>(input.payload, {
    temporaryReferences: input.temporaryReferences,
    onError: (error: unknown) => {
      input.ctx.callOnError(error, "rendering", {
        request: input.request,
        url: input.url,
        env: input.env,
      });
    },
  });
  return { type: "flight", payload: input.payload, stream, init };
}

function expectCommandResult(
  result: RscRenderCommandResult,
  type: "flight",
): RscFlightStage;
function expectCommandResult(
  result: RscRenderCommandResult,
  type: "html",
): RscHtmlResult;
function expectCommandResult(
  result: RscRenderCommandResult,
  type: "response",
): Response;
function expectCommandResult(
  result: RscRenderCommandResult,
  type: RscRenderCommandResult["type"],
): RscFlightStage | RscHtmlResult | Response {
  if (result.type !== type) {
    throw new Error(
      `[RSC] render plan expected ${type} result, received ${result.type}`,
    );
  }
  return result.value;
}

/**
 * Describe the foreground response-construction work without executing it.
 * Each command is yielded before its work starts; the driver owns execution,
 * attribution, and resumption.
 */
export function* createRscRenderPlan<TEnv>(
  input: RscRenderInput<TEnv>,
  options: RscRenderOptions = {},
): RscRenderPlan<TEnv> {
  const flight = expectCommandResult(
    yield {
      type: "flight",
      recordSerializeMetric: input.recordSerializeMetric ?? true,
      execute: () => createFlightStage(input, input.init),
    },
    "flight",
  );

  let body: BodyInit | null = flight.stream;
  let init = input.init;

  if (options.html) {
    const html = expectCommandResult(
      yield {
        type: "html",
        prepare: () => options.html!(flight),
      },
      "html",
    );
    body = html.body;
    init = { ...init, ...html.init };
  }

  return expectCommandResult(
    yield {
      type: "response",
      execute: () => createResponseWithMergedHeaders(body, init),
    },
    "response",
  );
}

/**
 * The exact command sequence createRscRenderPlan yields, derived from the SAME
 * `options.html` branch that shapes the plan. Callers pass this as the driver's
 * `phases` so `total` mirrors the number of commands and progress can never
 * report `completed > total`. Keep in lockstep with createRscRenderPlan.
 */
export function rscRenderPlanPhases(
  options: RscRenderOptions = {},
): readonly RscRenderPhase[] {
  return options.html ? ["flight", "html", "response"] : ["flight", "response"];
}

type StageSink = NonNullable<RscRenderStageTracking["onEvent"]>;

function emitStageEvent(
  sink: StageSink | undefined,
  createEvent: () => RscRenderStageEvent,
): void {
  if (!sink) return;
  try {
    sink(createEvent());
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[RSC] render stage event sink failed:", error);
    }
  }
}

function createStageContext(
  options: RscRenderDriverOptions,
  phase: RscRenderPhase,
  startedAt: number,
  phaseStartedAt: number,
  completed: number,
  total: number,
): RscRenderStageContext {
  return {
    mode: options.tracking?.mode ?? "unknown",
    phase,
    pathname: options.url.pathname,
    progress: { completed, total },
    startedAt,
    phaseStartedAt,
    ...(options.tracking?.routeKey && {
      routeKey: options.tracking.routeKey,
    }),
    ...(options.tracking?.actionId && {
      actionId: options.tracking.actionId,
    }),
  };
}

function commandResult<TEnv>(
  command: RscRenderCommand<TEnv>,
  value: RscFlightStage | RscHtmlResult | Response,
): RscRenderCommandResult {
  switch (command.type) {
    case "flight":
      return { type: "flight", value: value as RscFlightStage };
    case "html":
      return { type: "html", value: value as RscHtmlResult };
    case "response":
      return { type: "response", value: value as Response };
  }
}

function reportCleanupError(error: unknown, original: unknown): void {
  if (error === original || process.env.NODE_ENV === "production") return;
  console.error("[RSC] render plan cleanup failed:", error);
}

/**
 * Record the shared `rsc-serialize` Server-Timing metric. Sole owner of the
 * metric label and its (startedAt, durationMs) basis so the driver's flight
 * command and the standalone renderRscFlightStage cannot drift on either.
 */
function appendSerializeMetric(
  metricsStore: MetricsStore | undefined,
  record: boolean,
  startedAt: number,
  durationMs: number,
): void {
  if (record && metricsStore !== undefined) {
    appendMetric(metricsStore, "rsc-serialize", startedAt, durationMs);
  }
}

/** Execute a render plan while preserving the exact result/error identities. */
export async function driveRscRenderPlan<TEnv>(
  plan: RscRenderPlan<TEnv>,
  options: RscRenderDriverOptions,
): Promise<Response> {
  const sink = options.tracking?.onEvent;
  const requestContext = _getRequestContext();
  const diagnosticsEnabled =
    sink !== undefined ||
    requestContext?._renderDiagnosticsEnabled === true ||
    requestContext?._metricsStore !== undefined ||
    requestContext?._tracing !== undefined;
  const phases = options.phases;
  // `total` is derived from the caller's phase list (rscRenderPlanPhases for the
  // sanctioned path). Clamp up if a command sequence outruns it so progress
  // never reports `completed > total` for a mismatched plan.
  let total = phases.length;
  const pipelineStartedAt = diagnosticsEnabled ? performance.now() : 0;
  let completed = 0;
  let closed = false;

  options.tracking?.span?.setAttribute(
    "rango.render.mode",
    options.tracking.mode ?? "unknown",
  );

  try {
    let step = plan.next();
    while (!step.done) {
      const command = step.value;
      const metricsStore = requestContext?._metricsStore;
      const recordMetric =
        command.type === "flight" &&
        command.recordSerializeMetric &&
        metricsStore !== undefined;
      const measured = diagnosticsEnabled || recordMetric;
      const phaseStartedAt = measured ? performance.now() : 0;
      const startContext = sink
        ? createStageContext(
            options,
            command.type,
            pipelineStartedAt,
            phaseStartedAt,
            completed,
            total,
          )
        : undefined;

      if (requestContext && diagnosticsEnabled) {
        requestContext._renderForeground = {
          mode: options.tracking?.mode ?? "unknown",
          phase: command.type,
          state: "running",
          completed,
          total,
          pipelineStartedAt,
          phaseStartedAt,
          ...(options.tracking?.routeKey && {
            routeKey: options.tracking.routeKey,
          }),
          ...(options.tracking?.actionId && {
            actionId: options.tracking.actionId,
          }),
        };
      }
      options.tracking?.span?.setAttribute("rango.render.phase", command.type);

      emitStageEvent(sink, () => ({
        type: "stage:start",
        context: startContext!,
      }));

      let commandValue: RscFlightStage | RscHtmlResult | Response;
      try {
        if (command.type === "html") {
          const prepared = await command.prepare();
          const body = await observePhase(PHASES.ssr, prepared.render);
          commandValue = { body, init: prepared.init };
        } else {
          commandValue = command.execute();
        }
        const durationMs = measured ? performance.now() - phaseStartedAt : 0;
        appendSerializeMetric(
          metricsStore,
          recordMetric,
          phaseStartedAt,
          durationMs,
        );
        completed += 1;
        if (completed > total) total = completed;
        if (requestContext?._renderForeground) {
          requestContext._renderForeground.state = "paused";
          requestContext._renderForeground.completed = completed;
          requestContext._renderForeground.total = total;
          requestContext._renderForeground.phaseStartedAt = undefined;
        }
        const completeContext = sink
          ? createStageContext(
              options,
              command.type,
              pipelineStartedAt,
              phaseStartedAt,
              completed,
              total,
            )
          : undefined;
        emitStageEvent(sink, () => ({
          type: "stage:complete",
          context: completeContext!,
          durationMs,
        }));
      } catch (error) {
        options.tracking?.span?.setAttribute(
          "rango.render.error_phase",
          command.type,
        );
        const durationMs = measured ? performance.now() - phaseStartedAt : 0;
        emitStageEvent(sink, () => ({
          type: "stage:error",
          context: startContext!,
          durationMs,
          error,
        }));
        try {
          const recovery = plan.throw(error);
          if (recovery.done) {
            closed = true;
            if (recovery.value instanceof Response) return recovery.value;
            throw error;
          }
          step = recovery;
          continue;
        } catch (cleanupError) {
          reportCleanupError(cleanupError, error);
          closed = true;
        }
        throw error;
      }
      step = plan.next(commandResult(command, commandValue));
    }
    closed = true;
    if (!(step.value instanceof Response)) {
      throw new Error("[RSC] render plan completed without a Response");
    }
    return step.value;
  } finally {
    if (!closed) {
      try {
        plan.return(undefined);
      } catch (cleanupError) {
        reportCleanupError(cleanupError, undefined);
      }
    }
    // Clear unconditionally: once the driver exits, no render is active. A
    // timeout that fires afterward (e.g. a route-middleware fallback exceeding
    // the remaining budget) must not read a dead phase as the running render.
    if (requestContext) requestContext._renderForeground = undefined;
  }
}

/** Build a standard Flight or Flight+HTML response through the shared driver. */
export function renderRscResponse<TEnv>(
  input: RscRenderInput<TEnv>,
  options: RscRenderOptions = {},
): Promise<Response> {
  return driveRscRenderPlan(createRscRenderPlan(input, options), {
    url: input.url,
    tracking: input.tracking,
    phases: rscRenderPlanPhases(options),
  });
}

/**
 * Construct Flight directly for specialized post-commit paths such as PPR.
 * Standard responses use renderRscResponse so the driver owns every phase.
 */
export function renderRscFlightStage<TEnv>(
  input: RscFlightStageInput<TEnv>,
  init: ResponseInit = {},
): RscFlightStage {
  const sink = input.tracking?.onEvent;
  const metricsStore = _getRequestContext()?._metricsStore;
  const recordMetric =
    input.recordSerializeMetric === true && metricsStore !== undefined;
  const measured = sink !== undefined || recordMetric;
  const startedAt = measured ? performance.now() : 0;
  const context = sink
    ? createStageContext(
        { url: input.url, tracking: input.tracking, phases: ["flight"] },
        "flight",
        startedAt,
        startedAt,
        0,
        1,
      )
    : undefined;

  emitStageEvent(sink, () => ({ type: "stage:start", context: context! }));
  try {
    const stage = createFlightStage(input, init);
    const durationMs = measured ? performance.now() - startedAt : 0;
    appendSerializeMetric(metricsStore, recordMetric, startedAt, durationMs);
    emitStageEvent(sink, () => ({
      type: "stage:complete",
      context: createStageContext(
        { url: input.url, tracking: input.tracking, phases: ["flight"] },
        "flight",
        startedAt,
        startedAt,
        1,
        1,
      ),
      durationMs,
    }));
    return stage;
  } catch (error) {
    emitStageEvent(sink, () => ({
      type: "stage:error",
      context: context!,
      durationMs: measured ? performance.now() - startedAt : 0,
      error,
    }));
    throw error;
  }
}

export function createRscStageDebugSink(
  log: (message: string, details?: Record<string, unknown>) => void = (
    message,
    details,
  ) => console.debug(message, details),
): (event: RscRenderStageEvent) => void {
  return (event) => {
    const { context } = event;
    log(`[RSC][stage] ${event.type} ${context.phase}`, {
      mode: context.mode,
      pathname: context.pathname,
      routeKey: context.routeKey,
      actionId: context.actionId,
      progress: `${context.progress.completed}/${context.progress.total}`,
      ...("durationMs" in event && { durationMs: event.durationMs }),
      ...("error" in event && { error: event.error }),
    });
  };
}
