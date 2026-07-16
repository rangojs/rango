import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Agent, fetch as directFetch } from "undici";
import packageJson from "../../package.json";
import { createRangoMcpServer } from "./server.js";
import { selectRangoMcpRuntime } from "./runtime-registry.js";

const TOOL_CALL_TIMEOUT_MS = 10_000;

export interface RangoMcpConnectorOptions {
  projectRoot: string;
  instanceId?: string;
  registryDirectory?: string;
}

class RuntimeToolProxy {
  private client: Client | undefined;
  private callQueue: Promise<void> = Promise.resolve();
  private readonly dispatcher = new Agent({
    connect: {
      rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    },
  });

  constructor(private readonly options: RangoMcpConnectorOptions) {}

  private async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;

    const descriptor = await selectRangoMcpRuntime({
      projectRoot: this.options.projectRoot,
      instanceId: this.options.instanceId,
      registryDirectory: this.options.registryDirectory,
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(descriptor.endpoint),
      {
        requestInit: {
          redirect: "error",
          headers: {
            Authorization: `Bearer ${descriptor.token}`,
          },
        },
        fetch: (url, init) =>
          directFetch(url, {
            ...(init as Parameters<typeof directFetch>[1]),
            dispatcher: this.dispatcher,
          }) as unknown as Promise<Response>,
      },
    );
    const client = new Client({
      name: "Rango DevTools stdio connector",
      version: packageJson.version,
    });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  private async callOnce(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const result = await (
      await this.connect()
    ).callTool({ name, arguments: args }, undefined, {
      timeout: TOOL_CALL_TIMEOUT_MS,
    });
    if (!("content" in result)) {
      throw new Error(
        `Rango runtime returned an unsupported result for ${name}`,
      );
    }
    return result as CallToolResult;
  }

  private async callWithReconnect(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    try {
      return await this.callOnce(name, args);
    } catch {
      await this.disconnect();
      return await this.callOnce(name, args);
    }
  }

  call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const operation = this.callQueue.then(() =>
      this.callWithReconnect(name, args),
    );
    this.callQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async close(): Promise<void> {
    await this.callQueue;
    await this.disconnect();
    await this.dispatcher.close();
  }
}

export async function runRangoMcpConnector(
  options: RangoMcpConnectorOptions,
): Promise<void> {
  const proxy = new RuntimeToolProxy(options);
  const server = createRangoMcpServer(packageJson.version, {
    getProjectMetadata: () => proxy.call("get_project_metadata", {}),
    getDiscoveryStatus: () => proxy.call("get_discovery_status", {}),
    getRoutes: (input) => proxy.call("get_routes", { ...input }),
    getCompilationIssues: (input) =>
      proxy.call("get_compilation_issues", { ...input }),
    getErrors: (input) => proxy.call("get_errors", { ...input }),
    listRequests: (input) => proxy.call("list_requests", { ...input }),
    getRequestTrace: (input) => proxy.call("get_request_trace", { ...input }),
    explainRender: (input) => proxy.call("explain_render", { ...input }),
    explainCacheTags: (input) => proxy.call("explain_cache_tags", { ...input }),
    explainRevalidation: (input) =>
      proxy.call("explain_revalidation", { ...input }),
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void proxy.close();
  };
  await server.connect(transport);
}
