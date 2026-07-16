import { expect, test } from "@playwright/test";
import { connectRangoMcp, type RangoMcpTestSession } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

const WORKFLOW_FIXTURE = process.env.RANGO_WORKFLOW_FIXTURE;

function verifiesWorkflow(...fixtures: string[]): boolean {
  return !WORKFLOW_FIXTURE || fixtures.includes(WORKFLOW_FIXTURE);
}

test.describe("MCP devtools", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  let mcp: RangoMcpTestSession;

  test.beforeAll(async () => {
    mcp = await connectRangoMcp(f.root, f.url());
  });

  test.afterAll(async () => {
    await mcp.close();
  });

  test("reports Cloudflare routes and request diagnostics", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    if (verifiesWorkflow("dev-loop")) {
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
        capabilities: {
          recentRequests: true,
          runtimeErrors: true,
          renderExplanation: true,
          revalidationExplanation: true,
          cacheTagExplanation: true,
          sourceOwnership: true,
        },
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

      const response = await page.goto(f.url("/api/products/1"));
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
            transport: "response-route",
            routePattern: "/api/products/:id",
            completed: true,
            source: expect.objectContaining({
              file: "src/api/urls.tsx",
              precision: "declaration-file",
            }),
          }),
        ]);

      const trace = await mcp.client.callTool({
        name: "get_request_trace",
        arguments: { requestId },
      });
      expect(trace.structuredContent).toMatchObject({
        trace: { requestId, completed: true },
        source: { file: "src/api/urls.tsx", precision: "declaration-file" },
      });
      const errorResponse = await page.goto(
        f.url("/features/mcp-missing-feature"),
      );
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
    }

    if (verifiesWorkflow("render-cache-adoption", "render-cache-optimizer")) {
      const renderUrl = f.url(
        `/ppr-scoped?probe=mcp-render-${crypto.randomUUID()}`,
      );
      const coldRender = await page.goto(renderUrl);
      expect(await coldRender?.headerValue("x-rango-shell")).toBe("MISS");
      const captureRequestId =
        await coldRender?.headerValue("x-rango-request-id");
      expect(captureRequestId).toBeTruthy();
      await expect
        .poll(
          async () => {
            const result = await mcp.client.callTool({
              name: "explain_render",
              arguments: { requestId: captureRequestId },
            });
            return result.structuredContent?.ppr?.capture;
          },
          { timeout: 30_000 },
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ outcome: "captured" }),
          ]),
        );

      let renderRequestId: string | null = null;
      await expect
        .poll(
          async () => {
            const scoped = await page.goto(renderUrl);
            if ((await scoped?.headerValue("x-rango-shell")) !== "HIT") {
              return null;
            }
            renderRequestId =
              (await scoped?.headerValue("x-rango-request-id")) ?? null;
            return renderRequestId;
          },
          { timeout: 30_000 },
        )
        .toBeTruthy();

      await expect
        .poll(async () => {
          const result = await mcp.client.callTool({
            name: "explain_render",
            arguments: { requestId: renderRequestId },
          });
          return result.structuredContent;
        })
        .toMatchObject({
          request: { requestId: renderRequestId, transport: "document" },
          renderCache: expect.arrayContaining([
            expect.objectContaining({ kind: "inherited", outcome: "hit" }),
          ]),
          ppr: {
            document: expect.arrayContaining([
              expect.objectContaining({ outcome: "hit" }),
            ]),
          },
          loaders: expect.arrayContaining([
            expect.objectContaining({
              registrations: expect.arrayContaining([
                expect.objectContaining({ lane: "live" }),
              ]),
              consumers: expect.arrayContaining([
                expect.objectContaining({ containerValue: "request" }),
              ]),
            }),
            expect.objectContaining({
              registrations: expect.arrayContaining([
                expect.objectContaining({ lane: "baked" }),
              ]),
              cacheDecisions: expect.arrayContaining([
                expect.objectContaining({ outcome: "hit" }),
              ]),
              consumers: expect.arrayContaining([
                expect.objectContaining({
                  containerValue: "capture-generation",
                }),
              ]),
            }),
          ]),
        });
      const warmedExecution = await page
        .getByTestId("ppr-scoped-home")
        .textContent();
      const repeatedRender = await page.goto(renderUrl);
      expect(await repeatedRender?.headerValue("x-rango-shell")).toBe("HIT");
      await expect(page.getByTestId("ppr-scoped-home")).toHaveText(
        warmedExecution!,
      );
    }

    if (verifiesWorkflow("stale-data-debugger")) {
      const taggedResponse = await page.goto(
        f.url(`/cache-lab?probe=mcp-tags-${crypto.randomUUID()}`),
      );
      expect(taggedResponse?.status()).toBe(200);
      const taggedRequestId =
        await taggedResponse?.headerValue("x-rango-request-id");
      expect(taggedRequestId).toBeTruthy();
      await expect
        .poll(
          async () => {
            const result = await mcp.client.callTool({
              name: "explain_cache_tags",
              arguments: { requestId: taggedRequestId },
            });
            return result.structuredContent?.operations;
          },
          { timeout: 30_000 },
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "observe",
              artifact: "function",
              tags: expect.arrayContaining([
                expect.objectContaining({ value: "cache-lab:catalog" }),
                expect.objectContaining({
                  value: "cache-lab:product:alpha",
                }),
              ]),
            }),
          ]),
        );

      const invalidationResponse = await request.post(
        f.url("/api/cache/invalidate"),
        { data: { tags: ["cache-lab:product:alpha"] } },
      );
      expect(invalidationResponse.status()).toBe(200);
      const invalidationRequestId =
        invalidationResponse.headers()["x-rango-request-id"];
      expect(invalidationRequestId).toBeTruthy();
      await expect
        .poll(
          async () => {
            const result = await mcp.client.callTool({
              name: "explain_cache_tags",
              arguments: { requestId: invalidationRequestId },
            });
            return result.structuredContent?.operations;
          },
          { timeout: 30_000 },
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "invalidate",
              verb: "updateTag",
              outcome: "completed",
              tags: [
                expect.objectContaining({
                  value: "cache-lab:product:alpha",
                }),
              ],
            }),
          ]),
        );

      await page.goto(f.url("/swr-action?probe=mcp-revalidation"));
      await waitForHydration(page);
      const actionResponse = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).searchParams.has("_rsc_action"),
      );
      await page.getByTestId("swr-action-btn").click();
      const actionRequestId = await (
        await actionResponse
      ).headerValue("x-rango-request-id");
      expect(actionRequestId).toBeTruthy();
      await expect
        .poll(
          async () => {
            const result = await mcp.client.callTool({
              name: "explain_revalidation",
              arguments: { requestId: actionRequestId },
            });
            return result.structuredContent;
          },
          { timeout: 30_000 },
        )
        .toMatchObject({
          requestId: actionRequestId,
          isAction: true,
          actionId: expect.any(String),
          decisions: expect.arrayContaining([
            expect.objectContaining({ finalShouldRevalidate: true }),
          ]),
        });
    }

    if (!WORKFLOW_FIXTURE) {
      const failOpenResponse = await page.goto(
        f.url("/api/products/1?inject-diagnostic-failure=1"),
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
    }
  });
});

test.describe("MCP devtools (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("does not return an MCP response", async ({ page, request }) => {
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
    if (verifiesWorkflow("dev-loop")) {
      const appResponse = await page.goto(
        f.url("/api/products/1?inject-diagnostic-failure=1"),
      );
      expect(appResponse?.status()).toBe(200);
      expect(await appResponse?.headerValue("x-rango-request-id")).toBeNull();
    }
    if (verifiesWorkflow("render-cache-adoption", "render-cache-optimizer")) {
      const renderUrl = f.url(
        `/ppr-scoped?probe=mcp-render-production-${crypto.randomUUID()}`,
      );
      const coldRender = await page.goto(renderUrl);
      expect(await coldRender?.headerValue("x-rango-shell")).toBe("MISS");
      let renderResponse = coldRender;
      await expect
        .poll(
          async () => {
            renderResponse = await page.goto(renderUrl);
            return renderResponse?.headerValue("x-rango-shell");
          },
          { timeout: 30_000 },
        )
        .toBe("HIT");
      expect(
        await renderResponse?.headerValue("x-rango-request-id"),
      ).toBeNull();
      await expect(page.getByTestId("ppr-scoped-home")).toBeVisible();
      const warmedExecution = await page
        .getByTestId("ppr-scoped-home")
        .textContent();
      const repeatedRender = await page.goto(renderUrl);
      expect(await repeatedRender?.headerValue("x-rango-shell")).toBe("HIT");
      await expect(page.getByTestId("ppr-scoped-home")).toHaveText(
        warmedExecution!,
      );
    }
    if (verifiesWorkflow("stale-data-debugger")) {
      const taggedResponse = await page.goto(
        f.url(`/cache-lab?probe=mcp-tags-production-${crypto.randomUUID()}`),
      );
      expect(taggedResponse?.status()).toBe(200);
      expect(
        await taggedResponse?.headerValue("x-rango-request-id"),
      ).toBeNull();
      const invalidationResponse = await request.post(
        f.url("/api/cache/invalidate"),
        { data: { tags: ["cache-lab:product:alpha"] } },
      );
      expect(invalidationResponse.status()).toBe(200);
      expect(
        invalidationResponse.headers()["x-rango-request-id"],
      ).toBeUndefined();

      await page.goto(f.url("/swr-action?probe=mcp-revalidation-production"));
      await waitForHydration(page);
      const actionResponse = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).searchParams.has("_rsc_action"),
      );
      await page.getByTestId("swr-action-btn").click();
      expect(
        await (await actionResponse).headerValue("x-rango-request-id"),
      ).toBeNull();
      await expect(page.getByTestId("swr-action-page")).toBeVisible();
    }
  });
});
