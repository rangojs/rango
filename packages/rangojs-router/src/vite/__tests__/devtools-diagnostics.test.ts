import { describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { createRangoMcpDiagnosticStore } from "../../devtools-mcp/diagnostic-store.js";
import {
  RANGO_DIAGNOSTIC_BRIDGE_EVENT,
  RANGO_DIAGNOSTIC_BRIDGE_VERSION,
} from "../../router/diagnostics/bridge-protocol.js";
import { RANGO_BROWSER_NAVIGATION_EVENT } from "../../router/diagnostics/browser-protocol.js";
import { installRangoDevtoolsDiagnostics } from "../devtools-diagnostics.js";

describe("Vite devtools diagnostics", () => {
  it("ingests RSC realm events and tracks structured compilation recovery", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const hot = {
      on: vi.fn((event: string, listener: (value: unknown) => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn(),
      send: vi.fn(),
    };
    const warn = vi.fn();
    const server = {
      environments: { rsc: { hot } },
      config: { logger: { warn } },
      httpServer: { listening: true },
    } as unknown as ViteDevServer;
    const store = createRangoMcpDiagnosticStore({
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectRoot: "/workspace/app",
      getRouteSource: () => null,
    });
    const cleanup = installRangoDevtoolsDiagnostics({
      server,
      projectRoot: "/workspace/app",
      store,
    });

    listeners.get(RANGO_DIAGNOSTIC_BRIDGE_EVENT)!({
      bridgeVersion: RANGO_DIAGNOSTIC_BRIDGE_VERSION,
      diagnosticSchemaVersion: 1,
      realmId: "realm-1",
      batchSequence: 1,
      droppedEvents: 0,
      droppedEventsByRequest: [],
      events: [
        {
          schemaVersion: 1,
          sequence: 1,
          type: "request.started",
          timestamp: 1,
          requestId: "req-1",
          transactionId: "tx-1",
          routerId: "app",
          data: { method: "GET" },
        },
      ],
    });
    expect(store.listRequests().requests).toEqual([
      expect.objectContaining({ requestId: "req-1", method: "GET" }),
    ]);

    hot.send({
      type: "error",
      err: {
        message: "broken transform",
        id: "/workspace/app/src/router.tsx",
        plugin: "test",
        loc: { line: 4, column: 2 },
      },
    });
    expect(store.getCompilationIssues()).toMatchObject({
      capture: {
        structuredErrors: true,
        warnings: "recent-only",
      },
      issues: [
        expect.objectContaining({
          severity: "error",
          file: "src/router.tsx",
          freshness: "current",
        }),
      ],
    });

    hot.send({
      type: "update",
      updates: [{ path: "/src/router.tsx" }],
    });
    expect(store.getCompilationIssues().issues).toEqual([]);

    hot.send({
      type: "error",
      err: {
        message: "broken transform again",
        id: "/workspace/app/src/router.tsx",
      },
    });
    expect(store.getCompilationIssues().issues).toHaveLength(1);
    hot.send({
      type: "error",
      err: {
        message: "unrelated transform failure",
        id: "/workspace/app/src/other.tsx",
      },
    });
    hot.send({ type: "full-reload", triggeredBy: "/src/router.tsx" });
    expect(store.getCompilationIssues().issues).toEqual([
      expect.objectContaining({
        message: "unrelated transform failure",
        file: "src/other.tsx",
      }),
    ]);

    hot.send({
      type: "error",
      err: { message: "external failure", id: "/opt/shared/router.tsx" },
    });
    expect(store.getCompilationIssues().issues).toContainEqual(
      expect.objectContaining({
        message: "external failure",
        file: null,
        freshness: "recent",
      }),
    );

    cleanup();
    expect(hot.off).toHaveBeenCalledWith(
      RANGO_DIAGNOSTIC_BRIDGE_EVENT,
      expect.any(Function),
    );
  });

  it("ingests browser navigation events from the client environment", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const hot = {
      on: vi.fn((event: string, listener: (value: unknown) => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn(),
      send: vi.fn(),
    };
    const server = {
      environments: { client: { hot } },
      config: { logger: { warn: vi.fn() } },
      httpServer: { listening: true },
    } as unknown as ViteDevServer;
    const store = createRangoMcpDiagnosticStore({
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectRoot: "/workspace/app",
      getRouteSource: () => null,
    });
    const cleanup = installRangoDevtoolsDiagnostics({
      server,
      projectRoot: "/workspace/app",
      store,
    });

    listeners.get(RANGO_BROWSER_NAVIGATION_EVENT)!({
      version: 1,
      sequence: 1,
      documentId: "doc-00000000-0000-4000-8000-000000000001",
      navigationId: "nav-00000000-0000-4000-8000-000000000002",
      kind: "navigate",
      phase: "started",
      pathname: "/about",
    });

    expect(store.listNavigations().navigations).toEqual([
      expect.objectContaining({ pathname: "/about", eventCount: 1 }),
    ]);
    cleanup();
    expect(hot.off).toHaveBeenCalledWith(
      RANGO_BROWSER_NAVIGATION_EVENT,
      expect.any(Function),
    );
  });
});
