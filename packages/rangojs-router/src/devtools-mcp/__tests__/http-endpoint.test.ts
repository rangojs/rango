import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRangoMcpHttpMiddleware } from "../http-endpoint.js";
import { jsonToolResult } from "../server.js";

const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startEndpoint(): Promise<URL> {
  const middleware = createRangoMcpHttpMiddleware({
    token: "test-token-that-is-long-enough-for-auth",
    version: "1.0.0",
    handlers: {
      getProjectMetadata: () => jsonToolResult({ projectRoot: "/app" }),
      getDiscoveryStatus: () => jsonToolResult({ phase: "ready" }),
      getRoutes: () => jsonToolResult({ routes: [] }),
      matchRoute: () => jsonToolResult({ matched: false }),
      getCompilationIssues: () => jsonToolResult({ issues: [] }),
      getErrors: () => jsonToolResult({ errors: [] }),
      listRequests: () => jsonToolResult({ requests: [] }),
      listNavigations: () => jsonToolResult({ navigations: [] }),
      getNavigationTrace: () => jsonToolResult({ navigation: null }),
      getRequestTrace: () => jsonToolResult({ trace: null }),
      explainRender: () => jsonToolResult({ renderCache: [] }),
      explainCacheTags: () => jsonToolResult({ operations: [] }),
      explainRevalidation: () => jsonToolResult({ decisions: [] }),
    },
  });
  const server = createServer((request, response) => {
    middleware(request, response, () => {
      response.writeHead(404).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  return new URL(`http://127.0.0.1:${address.port}/__rango/mcp`);
}

describe("Rango MCP HTTP endpoint", () => {
  it("passes malformed request URLs to the next middleware", () => {
    const middleware = createRangoMcpHttpMiddleware({
      token: "test-token-that-is-long-enough-for-auth",
      version: "1.0.0",
      handlers: {} as never,
    });
    const next = vi.fn();

    middleware({ url: "http://[" } as never, {} as never, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("serves stateless MCP calls with the runtime bearer token", async () => {
    const url = await startEndpoint();
    const client = new Client({ name: "test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: {
            Authorization: "Bearer test-token-that-is-long-enough-for-auth",
          },
        },
      }),
    );

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(13);
    const result = await client.callTool({ name: "get_project_metadata" });
    expect(result.structuredContent).toEqual({ projectRoot: "/app" });
  });

  it("rejects unauthenticated and browser-origin requests", async () => {
    const url = await startEndpoint();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });

    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-that-is-long-enough-for-auth",
            "Content-Type": "application/json",
            Origin: "http://attacker.test",
          },
          body,
        })
      ).status,
    ).toBe(403);
  });
});
