import { expect, test } from "@playwright/test";
import { connectRangoMcp, type RangoMcpTestSession } from "@shared/e2e";
import { useFixture } from "./fixture";

test.describe("MCP devtools", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  let mcp: RangoMcpTestSession;

  test.beforeAll(async () => {
    mcp = await connectRangoMcp(f.root, f.url());
  });

  test.afterAll(async () => {
    await mcp.close();
  });

  test("reports live project, discovery, and route metadata", async () => {
    const tools = await mcp.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "get_discovery_status",
      "get_project_metadata",
      "get_routes",
    ]);

    const [project, status, routes] = await Promise.all([
      mcp.client.callTool({ name: "get_project_metadata" }),
      mcp.client.callTool({ name: "get_discovery_status" }),
      mcp.client.callTool({
        name: "get_routes",
        arguments: { limit: 1_000 },
      }),
    ]);
    expect(project.structuredContent).toMatchObject({
      preset: "node",
      mode: "development",
      capabilities: { routes: true, discoveryStatus: true },
    });

    expect(status.structuredContent).toMatchObject({
      phase: "ready",
      stale: false,
      runtimeConvergence: "not-applicable",
    });

    expect(routes.structuredContent?.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "blog.post",
          pattern: "/blog/:postId",
        }),
      ]),
    );
  });
});

test.describe("MCP devtools (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("does not mount the MCP endpoint", async ({ request }) => {
    const response = await request.post(f.url("/__rango/mcp"), {
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      },
    });
    expect(response.status()).toBe(404);
  });
});
