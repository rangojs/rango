import { isAbsolute, relative, resolve } from "node:path";
import type { ViteDevServer } from "vite";
import { RANGO_DIAGNOSTIC_BRIDGE_EVENT } from "../router/diagnostics/bridge-protocol.js";
import type { RangoMcpDiagnosticStore } from "../devtools-mcp/diagnostic-store.js";

interface HotChannel {
  on(event: string, listener: (data: unknown) => void): void;
  off?(event: string, listener: (data: unknown) => void): void;
  send(...args: unknown[]): unknown;
}

interface HotErrorPayload {
  type?: unknown;
  err?: {
    message?: unknown;
    stack?: unknown;
    id?: unknown;
    plugin?: unknown;
    frame?: unknown;
    loc?: { file?: unknown; line?: unknown; column?: unknown };
  };
  updates?: Array<{ path?: unknown; acceptedPath?: unknown }>;
  path?: unknown;
  triggeredBy?: unknown;
}

export interface InstallRangoDevtoolsDiagnosticsOptions {
  server: ViteDevServer;
  projectRoot: string;
  store: RangoMcpDiagnosticStore;
}

function projectFile(
  projectRoot: string,
  value: unknown,
  rootRelative: boolean = false,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const withoutQuery = value.split("?", 1)[0]!;
  if (!rootRelative && isAbsolute(withoutQuery)) {
    const projected = relative(projectRoot, withoutQuery);
    if (projected.startsWith("..") || isAbsolute(projected)) return undefined;
  }
  return rootRelative &&
    withoutQuery.startsWith("/") &&
    !withoutQuery.startsWith(projectRoot)
    ? resolve(projectRoot, `.${withoutQuery}`)
    : withoutQuery;
}

export function installRangoDevtoolsDiagnostics(
  options: InstallRangoDevtoolsDiagnosticsOptions,
): () => void {
  const bridgeListeners = new Map<HotChannel, (data: unknown) => void>();
  const sendWrappers = new Map<
    HotChannel,
    { original: HotChannel["send"]; wrapped: HotChannel["send"] }
  >();

  const capturePayload = (payload: unknown, environment: string): void => {
    if (!payload || typeof payload !== "object") return;
    const value = payload as HotErrorPayload;
    if (value.type === "error" && value.err) {
      const location = value.err.loc;
      const file = projectFile(
        options.projectRoot,
        location?.file ?? value.err.id,
      );
      options.store.recordCompilationIssue({
        severity: "error",
        message:
          value.err.message ?? value.err.stack ?? "Vite transform failed",
        plugin: value.err.plugin,
        file,
        line: location?.line,
        column: location?.column,
        frame: value.err.frame,
        environment,
        freshness: file ? "current" : "recent",
      });
      return;
    }
    if (value.type === "update" && Array.isArray(value.updates)) {
      options.store.resolveCompilationFiles(
        value.updates.flatMap((update) => {
          const files = [
            projectFile(options.projectRoot, update.path, true),
            projectFile(options.projectRoot, update.acceptedPath, true),
          ];
          return files.filter((file): file is string => file !== undefined);
        }),
        environment,
      );
      return;
    }
    if (value.type === "full-reload") {
      const file = projectFile(
        options.projectRoot,
        value.triggeredBy ?? value.path,
        true,
      );
      if (file) options.store.resolveCompilationFiles([file], environment);
    }
  };

  const registerChannels = (): void => {
    const environments = (
      options.server as ViteDevServer & {
        environments?: Record<string, { hot?: HotChannel }>;
      }
    ).environments;
    if (!environments) return;
    for (const [name, environment] of Object.entries(environments)) {
      const hot = environment.hot as HotChannel | undefined;
      if (!hot) continue;
      if (!sendWrappers.has(hot)) {
        const original = hot.send;
        const wrapped: HotChannel["send"] = function (
          this: HotChannel,
          ...args: unknown[]
        ): unknown {
          try {
            capturePayload(args[0], name);
          } catch {}
          return original.apply(this, args);
        };
        try {
          hot.send = wrapped;
          sendWrappers.set(hot, { original, wrapped });
        } catch {}
      }
      if (name === "rsc" && !bridgeListeners.has(hot)) {
        const listener = (data: unknown): void => {
          try {
            options.store.ingestBridgeBatch(data);
          } catch {}
        };
        hot.on(RANGO_DIAGNOSTIC_BRIDGE_EVENT, listener);
        bridgeListeners.set(hot, listener);
      }
    }
    options.store.setStructuredErrorCapture(sendWrappers.size > 0);
  };

  registerChannels();
  if (options.server.httpServer && !options.server.httpServer.listening) {
    options.server.httpServer.once("listening", registerChannels);
  }

  const logger = options.server.config
    .logger as typeof options.server.config.logger & {
    warn: (...args: unknown[]) => void;
  };
  const originalWarn = logger.warn;
  const wrappedWarn = (...args: unknown[]): void => {
    try {
      options.store.recordCompilationIssue({
        severity: "warning",
        message: args[0],
        freshness: "recent",
      });
    } catch {}
    originalWarn.apply(logger, args as Parameters<typeof originalWarn>);
  };
  try {
    logger.warn = wrappedWarn as typeof logger.warn;
  } catch {}

  return (): void => {
    if (logger.warn === wrappedWarn) logger.warn = originalWarn;
    for (const [hot, listener] of bridgeListeners) {
      hot.off?.(RANGO_DIAGNOSTIC_BRIDGE_EVENT, listener);
    }
    for (const [hot, { original, wrapped }] of sendWrappers) {
      if (hot.send === wrapped) hot.send = original;
    }
    bridgeListeners.clear();
    sendWrappers.clear();
  };
}
