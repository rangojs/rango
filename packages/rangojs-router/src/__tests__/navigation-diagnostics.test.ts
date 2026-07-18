import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RANGO_BROWSER_NAVIGATION_EVENT } from "../router/diagnostics/browser-protocol.js";

const UUID_PATTERN =
  /^(?:doc|nav)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

beforeEach(() => {
  vi.resetModules();
  let seed = 0;
  vi.stubGlobal("crypto", {
    getRandomValues(bytes: Uint8Array) {
      for (let index = 0; index < bytes.length; index++) {
        bytes[index] = (seed + index) & 0xff;
      }
      seed++;
      return bytes;
    },
  });
  vi.stubGlobal("window", {
    location: { origin: "http://192.168.1.10:5173", href: "/products" },
  });
  vi.stubGlobal("performance", {
    getEntriesByType: () => [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser navigation diagnostics", () => {
  it("replays navigation events queued before diagnostics installation", async () => {
    const bridge = await import("../browser/navigation-diagnostics-bridge.js");
    const navigation = bridge
      .getBrowserNavigationDiagnostics()!
      .start("navigate", "/products/queued");
    bridge.getBrowserNavigationDiagnostics()!.complete(navigation);
    const events: Array<{ phase: string; pathname: string }> = [];
    const diagnostics = await import("../browser/navigation-diagnostics.js");

    diagnostics.installBrowserNavigationDiagnostics({
      send(_event, data) {
        events.push(data as { phase: string; pathname: string });
      },
    });

    expect(
      events
        .filter((event) => event.pathname === "/products/queued")
        .map((event) => event.phase),
    ).toEqual(["started", "committed"]);
  });

  it("emits valid IDs without crypto.randomUUID", async () => {
    const events: unknown[] = [];
    const diagnostics = await import("../browser/navigation-diagnostics.js");
    diagnostics.installBrowserNavigationDiagnostics({
      send(event, data) {
        expect(event).toBe(RANGO_BROWSER_NAVIGATION_EVENT);
        events.push(data);
      },
    });

    const navigation = diagnostics.startBrowserNavigationDiagnostic(
      "navigate",
      "/products/2",
    );

    expect(navigation.id).toMatch(UUID_PATTERN);
    expect(events).not.toHaveLength(0);
    for (const event of events as Array<{
      documentId: string;
      navigationId: string;
    }>) {
      expect(event.documentId).toMatch(UUID_PATTERN);
      expect(event.navigationId).toMatch(UUID_PATTERN);
    }
  });

  it("keeps the first terminal phase and permits late request links", async () => {
    const events: Array<{ phase: string }> = [];
    const diagnostics = await import("../browser/navigation-diagnostics.js");
    diagnostics.installBrowserNavigationDiagnostics({
      send(_event, data) {
        events.push(data as { phase: string });
      },
    });
    events.length = 0;

    const navigation = diagnostics.startBrowserNavigationDiagnostic(
      "popstate",
      "/products/2",
    );
    diagnostics.completeBrowserNavigationDiagnostic(navigation);
    diagnostics.abortBrowserNavigationDiagnostic(navigation, true);
    diagnostics.completeBrowserNavigationDiagnostic(navigation);
    diagnostics.linkBrowserNavigationRequest(
      navigation,
      "req-00000000-0000-4000-8000-000000000001",
      "revalidation",
    );

    expect(events.map((event) => event.phase)).toEqual([
      "started",
      "committed",
      "request-linked",
    ]);
  });

  it("does not throw when the hot channel fails", async () => {
    const diagnostics = await import("../browser/navigation-diagnostics.js");
    expect(() =>
      diagnostics.installBrowserNavigationDiagnostics({
        send() {
          throw new Error("channel closed");
        },
      }),
    ).not.toThrow();
    expect(() =>
      diagnostics.startBrowserNavigationDiagnostic("navigate", "/products/2"),
    ).not.toThrow();
  });

  it("links the last valid request timing metric", async () => {
    vi.stubGlobal("performance", {
      getEntriesByType: () => [
        {
          serverTiming: [
            {
              name: "rango-request-id",
              description: "req-00000000-0000-4000-8000-000000000001",
            },
            { name: "rango-request-id", description: "invalid" },
            {
              name: "rango-request-id",
              description: "req-00000000-0000-4000-8000-000000000002",
            },
          ],
        },
      ],
    });
    const events: Array<{ phase: string; requestId?: string }> = [];
    const diagnostics = await import("../browser/navigation-diagnostics.js");
    diagnostics.installBrowserNavigationDiagnostics({
      send(_event, data) {
        events.push(data as { phase: string; requestId?: string });
      },
    });

    expect(
      events.find((event) => event.phase === "request-linked")?.requestId,
    ).toBe("req-00000000-0000-4000-8000-000000000002");
  });
});
