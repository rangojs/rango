import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createRangoMcpServer, jsonToolResult } from "../server.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function createClient(): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRangoMcpServer("1.0.0", {
    getProjectMetadata: () => jsonToolResult({ projectRoot: "/app" }),
    getDiscoveryStatus: () => jsonToolResult({ phase: "ready" }),
    getRoutes: (input) => jsonToolResult({ input, routes: [] }),
    getCompilationIssues: (input) => jsonToolResult({ input, issues: [] }),
    getErrors: (input) => jsonToolResult({ input, errors: [] }),
    listRequests: (input) => jsonToolResult({ input, requests: [] }),
    getRequestTrace: (input) => jsonToolResult({ input, trace: null }),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("Rango MCP server", () => {
  it("exposes the Phase 0 and Phase 2 read-only tools", async () => {
    const client = await createClient();
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "get_compilation_issues",
      "get_discovery_status",
      "get_errors",
      "get_project_metadata",
      "get_request_trace",
      "get_routes",
      "list_requests",
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(
      true,
    );
  });

  it("validates route arguments and returns structured content", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_routes",
      arguments: { routerId: "api", limit: 10 },
    });

    expect(result.structuredContent).toEqual({
      input: { routerId: "api", limit: 10 },
      routes: [],
    });
    const invalid = await client.callTool({
      name: "get_routes",
      arguments: { limit: 10_000 },
    });
    expect(invalid.isError).toBe(true);

    const longCursor = "x".repeat(10_000);
    const paginated = await client.callTool({
      name: "list_requests",
      arguments: { cursor: longCursor },
    });
    expect(paginated.structuredContent).toMatchObject({
      input: { cursor: longCursor },
    });
  });

  it("rejects an unexpectedly oversized tool result", () => {
    expect(() => jsonToolResult({ value: "x".repeat(256 * 1024) })).toThrow(
      "exceeded its output limit",
    );
  });
});
