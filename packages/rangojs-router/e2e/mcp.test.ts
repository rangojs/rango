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

  test("reports live routes and request diagnostics", async ({ page }) => {
    const tools = await mcp.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "get_compilation_issues",
      "get_discovery_status",
      "get_errors",
      "get_project_metadata",
      "get_request_trace",
      "get_routes",
      "list_requests",
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

    const response = await page.goto(f.url("/blog/mcp-phase-2"));
    expect(response?.status()).toBe(200);
    const requestId = await response?.headerValue("x-rango-request-id");
    expect(requestId).toBeTruthy();

    await expect
      .poll(async () => {
        const result = await mcp.client.callTool({
          name: "list_requests",
          arguments: { requestId },
        });
        return result.structuredContent?.requests;
      })
      .toEqual([
        expect.objectContaining({
          requestId,
          method: "GET",
          transport: "document",
          routePattern: "/blog/:postId",
          completed: true,
          source: expect.objectContaining({
            file: "src/urls/blog.tsx",
            precision: "declaration-file",
          }),
        }),
      ]);

    const trace = await mcp.client.callTool({
      name: "get_request_trace",
      arguments: { requestId },
    });
    expect(trace.structuredContent).toMatchObject({
      trace: {
        requestId,
        completed: true,
      },
      source: {
        file: "src/urls/blog.tsx",
        precision: "declaration-file",
      },
    });

    const errorResponse = await page.goto(f.url("/__test/throw-handler-error"));
    expect(errorResponse?.status()).toBe(500);
    const errorRequestId =
      await errorResponse?.headerValue("x-rango-request-id");
    expect(errorRequestId).toBeTruthy();
    await expect
      .poll(async () => {
        const result = await mcp.client.callTool({
          name: "get_errors",
          arguments: { requestId: errorRequestId },
        });
        return result.structuredContent?.errors;
      })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: errorRequestId,
            type: expect.stringMatching(/failed|error/),
          }),
        ]),
      );

    const failOpenResponse = await page.goto(
      f.url("/blog/mcp-phase-2?inject-diagnostic-failure=1"),
    );
    expect(failOpenResponse?.status()).toBe(200);
    const failOpenRequestId =
      await failOpenResponse?.headerValue("x-rango-request-id");
    await expect
      .poll(async () => {
        const result = await mcp.client.callTool({
          name: "list_requests",
          arguments: { requestId: failOpenRequestId },
        });
        const content = result.structuredContent;
        return content?.requests?.[0]?.requestId === failOpenRequestId
          ? content.stats?.bridgeDroppedEvents
          : 0;
      })
      .toBeGreaterThan(0);
  });
});

test.describe("MCP devtools (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("does not mount the MCP endpoint", async ({ page, request }) => {
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
    const appResponse = await page.goto(
      f.url("/blog/mcp-phase-2?inject-diagnostic-failure=1"),
    );
    expect(appResponse?.status()).toBe(200);
    expect(await appResponse?.headerValue("x-rango-request-id")).toBeNull();
  });
});
