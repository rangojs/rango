import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Enable debug mode before importing logging module
vi.stubEnv("INTERNAL_RANGO_DEBUG", "1");

const { runWithRouterLogContext, withRouterLogScope } =
  await import("../logging");

describe("withRouterLogScope", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function withinLogContext<T>(fn: () => T): T {
    const req = new Request("http://localhost/test");
    return runWithRouterLogContext({ request: req, transaction: "test" }, fn);
  }

  function logMessages(): string[] {
    return consoleSpy.mock.calls.map((c: unknown[]) => c[0] as string);
  }

  it("logs start and end for successful async scope", async () => {
    await withinLogContext(() =>
      withRouterLogScope("myScope", async () => "ok"),
    );

    const messages = logMessages();
    expect(messages.some((m) => m.includes("[myScope] start"))).toBe(true);
    expect(messages.some((m) => m.includes("[myScope] end"))).toBe(true);
    expect(messages.some((m) => m.includes("[myScope] error"))).toBe(false);
  });

  it("logs start and error for rejected async scope", async () => {
    await expect(
      withinLogContext(() =>
        withRouterLogScope("myScope", async () => {
          throw new Error("async boom");
        }),
      ),
    ).rejects.toThrow("async boom");

    const messages = logMessages();
    expect(messages.some((m) => m.includes("[myScope] start"))).toBe(true);
    expect(messages.some((m) => m.includes("[myScope] error"))).toBe(true);
    expect(messages.some((m) => m.includes("[myScope] end"))).toBe(false);
  });

  it("logs start and error for synchronous throw", () => {
    expect(() =>
      withinLogContext(() =>
        withRouterLogScope("myScope", () => {
          throw new Error("sync boom");
        }),
      ),
    ).toThrow("sync boom");

    const messages = logMessages();
    expect(messages.some((m) => m.includes("[myScope] start"))).toBe(true);
    expect(messages.some((m) => m.includes("[myScope] error"))).toBe(true);
    expect(messages.some((m) => m.includes("[myScope] end"))).toBe(false);
  });
});
