import { expect, test } from "@playwright/test";
import { connectRangoMcp, type RangoMcpTestSession } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

const WORKFLOW_FIXTURE = process.env.RANGO_WORKFLOW_FIXTURE;

function verifiesWorkflow(...fixtures: string[]): boolean {
  return !WORKFLOW_FIXTURE || fixtures.includes(WORKFLOW_FIXTURE);
}

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
    if (verifiesWorkflow("dev-loop")) {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "explain_cache_tags",
        "explain_render",
        "explain_revalidation",
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
        toolSchemaVersion: 4,
        capabilities: {
          routes: true,
          discoveryStatus: true,
          renderExplanation: true,
          revalidationExplanation: true,
          cacheTagExplanation: true,
        },
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
      const errorResponse = await page.goto(
        f.url("/__test/throw-handler-error"),
      );
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
    }

    if (verifiesWorkflow("render-cache-adoption", "render-cache-optimizer")) {
      const renderUrl = f.url(
        `/shell-cache/scoped?probe=mcp-render-${crypto.randomUUID()}`,
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
          request: {
            requestId: renderRequestId,
            transport: "document",
          },
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
                expect.objectContaining({
                  lane: "live",
                  containerValue: "request",
                }),
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
                  lane: "baked",
                  containerValue: "capture-generation",
                }),
              ]),
            }),
          ]),
        });
      const warmedExecution = await page
        .getByTestId("shell-scoped-home")
        .textContent();
      const repeatedRender = await page.goto(renderUrl);
      expect(await repeatedRender?.headerValue("x-rango-shell")).toBe("HIT");
      await expect(page.getByTestId("shell-scoped-home")).toHaveText(
        warmedExecution!,
      );
    }

    if (verifiesWorkflow("stale-data-debugger")) {
      const taggedResponse = await page.goto(
        f.url(`/cache-tag-test/catalog/mcp-tags-${crypto.randomUUID()}`),
      );
      expect(taggedResponse?.status()).toBe(200);
      const taggedRequestId =
        await taggedResponse?.headerValue("x-rango-request-id");
      expect(taggedRequestId).toBeTruthy();
      await expect
        .poll(async () => {
          const result = await mcp.client.callTool({
            name: "explain_cache_tags",
            arguments: { requestId: taggedRequestId },
          });
          return result.structuredContent;
        })
        .toMatchObject({
          requestId: taggedRequestId,
          valuesExposed: true,
          storeState: "not-inspected",
          operations: expect.arrayContaining([
            expect.objectContaining({
              kind: "observe",
              tags: expect.arrayContaining([
                expect.objectContaining({ value: "catalog" }),
              ]),
            }),
          ]),
        });

      const invalidationResponse = await page.goto(
        f.url("/cache-tag-test/invalidate/catalog"),
      );
      expect(invalidationResponse?.status()).toBe(200);
      const invalidationRequestId =
        await invalidationResponse?.headerValue("x-rango-request-id");
      expect(invalidationRequestId).toBeTruthy();
      await expect
        .poll(async () => {
          const result = await mcp.client.callTool({
            name: "explain_cache_tags",
            arguments: { requestId: invalidationRequestId },
          });
          return result.structuredContent?.operations;
        })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "invalidate",
              verb: "updateTag",
              outcome: "requested",
              tags: [expect.objectContaining({ value: "catalog" })],
            }),
            expect.objectContaining({
              kind: "invalidate",
              verb: "updateTag",
              outcome: "completed",
              tags: [expect.objectContaining({ value: "catalog" })],
            }),
          ]),
        );

      await page.goto(f.url("/revalidation-contract"));
      await waitForHydration(page);
      const actionResponse = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).searchParams.has("_rsc_action"),
      );
      await page.getByTestId("revalidation-contract-action-btn").click();
      const actionRequestId = await (
        await actionResponse
      ).headerValue("x-rango-request-id");
      expect(actionRequestId).toBeTruthy();
      await expect
        .poll(async () => {
          const result = await mcp.client.callTool({
            name: "explain_revalidation",
            arguments: { requestId: actionRequestId },
          });
          return result.structuredContent;
        })
        .toMatchObject({
          requestId: actionRequestId,
          isAction: true,
          actionId: expect.any(String),
          decisions: expect.arrayContaining([
            expect.objectContaining({
              kind: "segment",
              finalShouldRevalidate: true,
            }),
            expect.objectContaining({
              kind: "segment",
              finalShouldRevalidate: false,
            }),
          ]),
        });
      await expect(
        page.getByTestId("revalidation-contract-action-cookie"),
      ).toHaveText("set");
    }

    if (!WORKFLOW_FIXTURE) {
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
    }
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
    if (verifiesWorkflow("dev-loop")) {
      const appResponse = await page.goto(
        f.url("/blog/mcp-phase-2?inject-diagnostic-failure=1"),
      );
      expect(appResponse?.status()).toBe(200);
      expect(await appResponse?.headerValue("x-rango-request-id")).toBeNull();
    }

    if (verifiesWorkflow("render-cache-adoption", "render-cache-optimizer")) {
      const renderUrl = f.url(
        `/shell-cache/scoped?probe=mcp-render-production-${crypto.randomUUID()}`,
      );
      const coldRender = await page.goto(renderUrl);
      expect(await coldRender?.headerValue("x-rango-shell")).toBe("MISS");
      let renderResponse = coldRender;
      await expect
        .poll(async () => {
          renderResponse = await page.goto(renderUrl);
          return renderResponse?.headerValue("x-rango-shell");
        })
        .toBe("HIT");
      expect(
        await renderResponse?.headerValue("x-rango-request-id"),
      ).toBeNull();
      await expect(page.getByTestId("shell-scoped-home")).toBeVisible();
      const warmedExecution = await page
        .getByTestId("shell-scoped-home")
        .textContent();
      const repeatedRender = await page.goto(renderUrl);
      expect(await repeatedRender?.headerValue("x-rango-shell")).toBe("HIT");
      await expect(page.getByTestId("shell-scoped-home")).toHaveText(
        warmedExecution!,
      );
    }
    if (verifiesWorkflow("stale-data-debugger")) {
      const taggedResponse = await page.goto(
        f.url(
          `/cache-tag-test/catalog/mcp-tags-production-${crypto.randomUUID()}`,
        ),
      );
      expect(taggedResponse?.status()).toBe(200);
      expect(
        await taggedResponse?.headerValue("x-rango-request-id"),
      ).toBeNull();
      const invalidationResponse = await page.goto(
        f.url("/cache-tag-test/invalidate/catalog"),
      );
      expect(invalidationResponse?.status()).toBe(200);
      expect(
        await invalidationResponse?.headerValue("x-rango-request-id"),
      ).toBeNull();

      await page.goto(f.url("/revalidation-contract"));
      await waitForHydration(page);
      const actionResponse = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).searchParams.has("_rsc_action"),
      );
      await page.getByTestId("revalidation-contract-action-btn").click();
      expect(
        await (await actionResponse).headerValue("x-rango-request-id"),
      ).toBeNull();
      await expect(
        page.getByTestId("revalidation-contract-action-cookie"),
      ).toHaveText("set");
    }
  });
});
