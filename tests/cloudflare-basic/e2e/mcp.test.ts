import { expect, test } from "@playwright/test";
import { connectRangoMcp, type RangoMcpTestSession } from "@shared/e2e";
import { useFixture } from "./fixture";

test.describe("MCP devtools", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  let mcp: RangoMcpTestSession;

  test.beforeAll(async () => {
    mcp = await connectRangoMcp(f.root, f.url());
  });

  test.afterAll(async () => {
    await mcp.close();
  });

  test("reports Cloudflare runtime route discovery", async () => {
    const [project, routes] = await Promise.all([
      mcp.client.callTool({ name: "get_project_metadata" }),
      mcp.client.callTool({
        name: "get_routes",
        arguments: { limit: 1_000 },
      }),
    ]);
    expect(project.structuredContent).toMatchObject({
      preset: "cloudflare",
      mode: "development",
    });

    await expect
      .poll(async () => {
        const status = await mcp.client.callTool({
          name: "get_discovery_status",
        });
        return status.structuredContent;
      })
      .toMatchObject({
        phase: "ready",
        stale: false,
        runtimeConvergence: "ready",
      });

    expect(routes.structuredContent?.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "api.productDetail",
          pattern: "/api/products/:id",
        }),
      ]),
    );
  });
});

test.describe("MCP devtools (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("does not return an MCP response", async ({ request }) => {
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
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
    expect(await response.text()).not.toContain('"jsonrpc"');
  });
});
