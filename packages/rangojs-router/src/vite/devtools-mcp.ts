import type { AddressInfo } from "node:net";
import { isAbsolute, relative } from "node:path";
import type { ViteDevServer } from "vite";
import {
  createRangoMcpRuntimeIdentity,
  registerRangoMcpRuntime,
  type RuntimeRegistration,
} from "../devtools-mcp/runtime-registry.js";
import { createRangoMcpHttpMiddleware } from "../devtools-mcp/http-endpoint.js";
import {
  RANGO_MCP_ENDPOINT,
  type RangoPreset,
} from "../devtools-mcp/protocol.js";
import {
  createRangoMcpSnapshotStore,
  type RangoMcpSnapshotStore,
} from "../devtools-mcp/snapshot-store.js";
import { createSnapshotToolHandlers } from "../devtools-mcp/server.js";
import { rangoVersion } from "./utils/banner.js";

export interface InstallRangoMcpOptions {
  server: ViteDevServer;
  projectRoot: string;
  preset: RangoPreset;
  mode: string;
  entryFile: string | undefined;
}

function projectRelativeFile(
  projectRoot: string,
  file: string | undefined,
): string | null {
  if (!file) return null;
  const result = relative(projectRoot, file);
  if (result === "" || result.startsWith("..") || isAbsolute(result)) {
    return null;
  }
  return result.replaceAll("\\", "/");
}

function serverUrls(server: ViteDevServer): string[] {
  return [
    ...(server.resolvedUrls?.local ?? []),
    ...(server.resolvedUrls?.network ?? []),
  ];
}

function localServerOrigin(server: ViteDevServer): string | null {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") return null;
  const port = (address as AddressInfo).port;
  const hostname =
    address.address === "::" || address.address === "::1"
      ? "[::1]"
      : "127.0.0.1";
  const protocol = server.config.server.https ? "https" : "http";
  return `${protocol}://${hostname}:${port}/`;
}

export function installRangoMcp(
  options: InstallRangoMcpOptions,
): RangoMcpSnapshotStore {
  const identity = createRangoMcpRuntimeIdentity();
  const store = createRangoMcpSnapshotStore({
    projectRoot: options.projectRoot,
    preset: options.preset,
    mode: options.mode,
    entryFile: projectRelativeFile(options.projectRoot, options.entryFile),
    rangoVersion,
    instanceId: identity.instanceId,
    startedAt: identity.startedAt,
    getDevServerUrls: () => serverUrls(options.server),
  });

  options.server.middlewares.use(
    createRangoMcpHttpMiddleware({
      token: identity.token,
      version: rangoVersion,
      handlers: createSnapshotToolHandlers(store),
    }),
  );

  let registration: RuntimeRegistration | undefined;
  let closed = false;
  const registerRuntime = async (): Promise<void> => {
    const origin = localServerOrigin(options.server);
    if (!origin || closed) return;
    const nextRegistration = await registerRangoMcpRuntime({
      identity,
      projectRoot: options.projectRoot,
      preset: options.preset,
      endpoint: new URL(RANGO_MCP_ENDPOINT, origin).href,
    });
    if (closed) {
      await nextRegistration.dispose();
      return;
    }
    registration = nextRegistration;
  };

  if (options.server.httpServer?.listening) {
    void registerRuntime().catch((error: unknown) => {
      options.server.config.logger.warn(
        `[rango] Failed to register MCP runtime: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } else {
    options.server.httpServer?.once("listening", () => {
      void registerRuntime().catch((error: unknown) => {
        options.server.config.logger.warn(
          `[rango] Failed to register MCP runtime: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  options.server.httpServer?.once("close", () => {
    closed = true;
    void registration?.dispose();
  });

  return store;
}
