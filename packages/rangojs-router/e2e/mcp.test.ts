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
        "get_navigation_trace",
        "get_project_metadata",
        "get_request_trace",
        "get_routes",
        "list_navigations",
        "list_requests",
        "match_route",
      ]);

      const [project, status, routes, matchedRoute] = await Promise.all([
        mcp.client.callTool({ name: "get_project_metadata" }),
        mcp.client.callTool({ name: "get_discovery_status" }),
        mcp.client.callTool({
          name: "get_routes",
          arguments: { limit: 1_000 },
        }),
        mcp.client.callTool({
          name: "match_route",
          arguments: { url: "/blog/mcp-phase-2?secret=ignored" },
        }),
      ]);
      expect(project.structuredContent).toMatchObject({
        preset: "node",
        mode: "development",
        toolSchemaVersion: 5,
        capabilities: {
          routes: true,
          routeMatching: true,
          discoveryStatus: true,
          renderExplanation: true,
          revalidationExplanation: true,
          cacheTagExplanation: true,
          browserState: true,
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
      expect(matchedRoute.structuredContent).toMatchObject({
        pathname: "/blog/mcp-phase-2",
        matched: true,
        route: {
          name: "blog.post",
          pattern: "/blog/:postId",
          params: { postId: "mcp-phase-2" },
          structure: {
            segments: expect.arrayContaining([
              expect.objectContaining({ type: "route" }),
            ]),
          },
        },
      });
      expect(JSON.stringify(matchedRoute.structuredContent)).not.toContain(
        "secret",
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

      await page.goto(f.url("/tx-src/a"));
      await waitForHydration(page);
      const navigationResponse = page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === "/tx-src/b" &&
          new URL(candidate.url()).searchParams.has("_rsc_partial"),
      );
      await page.getByTestId("tx-src-to-b").click();
      await expect(page.getByTestId("tx-src-n")).toHaveText("b");
      const navigationRequestId = await (
        await navigationResponse
      ).headerValue("x-rango-request-id");
      expect(navigationRequestId).toBeTruthy();
      let navigationId: string | undefined;
      await expect
        .poll(async () => {
          const result = await mcp.client.callTool({
            name: "list_navigations",
            arguments: { kind: "navigate", completed: true },
          });
          const navigation = result.structuredContent?.navigations?.find(
            (candidate: { pathname?: string }) =>
              candidate.pathname === "/tx-src/b",
          );
          navigationId = navigation?.navigationId;
          return navigation;
        })
        .toMatchObject({
          pathname: "/tx-src/b",
          requestIds: [navigationRequestId],
        });
      const navigationTrace = await mcp.client.callTool({
        name: "get_navigation_trace",
        arguments: { navigationId },
      });
      expect(navigationTrace.structuredContent).toMatchObject({
        navigationId,
        completed: true,
        requestIds: [navigationRequestId],
        events: expect.arrayContaining([
          expect.objectContaining({ phase: "started" }),
          expect.objectContaining({
            phase: "request-linked",
            requestId: navigationRequestId,
            role: "navigation",
          }),
          expect.objectContaining({ phase: "committed" }),
        ]),
      });
      const linkedRequest = await mcp.client.callTool({
        name: "list_requests",
        arguments: { navigationId },
      });
      expect(linkedRequest.structuredContent?.requests).toEqual([
        expect.objectContaining({ requestId: navigationRequestId }),
      ]);

      await page.goto(f.url("/location-state"));
      await waitForHydration(page);
      const redirectActionResponse = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).searchParams.has("_rsc_action"),
      );
      await page.getByTestId("action-simple-redirect-btn").click();
      await expect(page).toHaveURL(/\/location-state\/target$/);
      const redirectActionRequestId = await (
        await redirectActionResponse
      ).headerValue("x-rango-request-id");
      expect(redirectActionRequestId).toBeTruthy();
      let actionNavigationId: string | undefined;
      await expect
        .poll(async () => {
          const result = await mcp.client.callTool({
            name: "list_navigations",
            arguments: { kind: "action", completed: true },
          });
          const navigation = result.structuredContent?.navigations?.find(
            (candidate: { requestIds?: string[] }) =>
              candidate.requestIds?.includes(redirectActionRequestId!),
          );
          actionNavigationId = navigation?.navigationId;
          return navigation;
        })
        .toMatchObject({ requestIds: [redirectActionRequestId] });
      const actionNavigationTrace = await mcp.client.callTool({
        name: "get_navigation_trace",
        arguments: { navigationId: actionNavigationId },
      });
      expect(actionNavigationTrace.structuredContent).toMatchObject({
        completed: true,
        events: expect.arrayContaining([
          expect.objectContaining({
            phase: "request-linked",
            requestId: redirectActionRequestId,
            role: "action",
          }),
          expect.objectContaining({ phase: "committed" }),
        ]),
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
            expect.objectContaining({
              outcome: "captured",
              storeWrite: "stored",
            }),
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
      await expect
        .poll(async () => {
          const result = await mcp.client.callTool({
            name: "explain_cache_tags",
            arguments: { requestId: renderRequestId },
          });
          return result.structuredContent?.operations;
        })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              artifact: "runtime-shell",
              phase: "hit",
              provenance: ["stored"],
              tags: expect.arrayContaining([
                expect.objectContaining({ value: "mcp-shell-scoped" }),
              ]),
            }),
          ]),
        );
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

      const responseCacheUrl = f.url(
        `/response-cache/cached-json?probe=mcp-stored-${crypto.randomUUID()}`,
      );
      const coldResponseRoute = await page.goto(responseCacheUrl);
      expect(coldResponseRoute?.status()).toBe(200);
      const warmResponseRoute = await page.goto(responseCacheUrl);
      const warmResponseRequestId =
        await warmResponseRoute?.headerValue("x-rango-request-id");
      expect(warmResponseRequestId).toBeTruthy();
      await expect
        .poll(async () => {
          const result = await mcp.client.callTool({
            name: "explain_cache_tags",
            arguments: { requestId: warmResponseRequestId },
          });
          return result.structuredContent?.operations;
        })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              artifact: "response-route",
              phase: "hit",
              provenance: ["stored"],
              tags: expect.arrayContaining([
                expect.objectContaining({ value: "mcp-response-cache" }),
              ]),
            }),
          ]),
        );

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
          const request = content?.requests?.[0];
          return request?.requestId === failOpenRequestId &&
            request.droppedEvents > 0 &&
            request.truncated === true &&
            content.stats?.bridgeDroppedEvents > 0
            ? request
            : null;
        })
        .toMatchObject({ requestId: failOpenRequestId, truncated: true });
      const lossyExplanation = await mcp.client.callTool({
        name: "explain_render",
        arguments: { requestId: failOpenRequestId },
      });
      expect(lossyExplanation.structuredContent).toMatchObject({
        truncated: true,
      });
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

      await page.goto(f.url("/tx-src/a"));
      await waitForHydration(page);
      const navigationResponse = page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === "/tx-src/b" &&
          new URL(candidate.url()).searchParams.has("_rsc_partial"),
      );
      await page.getByTestId("tx-src-to-b").click();
      await expect(page.getByTestId("tx-src-n")).toHaveText("b");
      const productionNavigationResponse = await navigationResponse;
      expect(
        productionNavigationResponse.request().headers()[
          "x-rango-navigation-id"
        ],
      ).toBeUndefined();
      expect(
        await productionNavigationResponse.headerValue("x-rango-request-id"),
      ).toBeNull();

      await page.goto(f.url("/location-state"));
      await waitForHydration(page);
      const redirectActionResponse = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).searchParams.has("_rsc_action"),
      );
      await page.getByTestId("action-simple-redirect-btn").click();
      await expect(page).toHaveURL(/\/location-state\/target$/);
      const productionActionResponse = await redirectActionResponse;
      expect(
        productionActionResponse.request().headers()["x-rango-navigation-id"],
      ).toBeUndefined();
      expect(
        await productionActionResponse.headerValue("x-rango-request-id"),
      ).toBeNull();
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
      const responseCacheUrl = f.url(
        `/response-cache/cached-json?probe=mcp-stored-production-${crypto.randomUUID()}`,
      );
      const coldResponseRoute = await page.goto(responseCacheUrl);
      const coldBody = await coldResponseRoute?.text();
      const warmResponseRoute = await page.goto(responseCacheUrl);
      expect(await warmResponseRoute?.text()).toBe(coldBody);
      expect(
        await warmResponseRoute?.headerValue("x-rango-request-id"),
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
