/**
 * warnAwaitedSsrSuspension — the dev-only SSR diagnostic for { ssr: false }.
 *
 * The warning must name an unflagged sibling read that suspends a boundary on
 * a document render that awaited flagged loaders, stay silent everywhere else
 * (browser pass, no flagged loaders, synchronously-unwrappable Flight chunks,
 * production), and fire at most once per loader id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { warnAwaitedSsrSuspension } from "../ssr-suspension-warning";

function pendingStream(): Promise<unknown> {
  return new Promise(() => {});
}

function chunkWithStatus(status: string): Promise<unknown> {
  const p = new Promise(() => {});
  (p as any).status = status;
  return p;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("warnAwaitedSsrSuspension", () => {
  it("warns once for an unflagged sibling read, naming both sides", () => {
    warnAwaitedSsrSuspension("sidecar#1", ["product#1"], pendingStream(), true);
    warnAwaitedSsrSuspension("sidecar#1", ["product#1"], pendingStream(), true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]![0] as string;
    expect(message).toContain('useLoader("sidecar#1")');
    expect(message).toContain('["product#1"]');
    expect(message).toContain("{ ssr: false }");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("errors (report-a-bug) when the flagged loader itself is still pending", () => {
    warnAwaitedSsrSuspension("product#2", ["product#2"], pendingStream(), true);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]![0] as string;
    expect(message).toContain('"product#2"');
    expect(message).toContain("report");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is silent when the render awaited no flagged loaders", () => {
    warnAwaitedSsrSuspension("plain#3", undefined, pendingStream(), true);
    warnAwaitedSsrSuspension("plain#3b", [], pendingStream(), true);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is silent in the browser pass", () => {
    warnAwaitedSsrSuspension(
      "sidecar#4",
      ["product#4"],
      pendingStream(),
      false,
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is silent for chunks use() unwraps without suspending", () => {
    for (const status of ["fulfilled", "resolved_model", "resolved_module"]) {
      warnAwaitedSsrSuspension(
        `sidecar#5-${status}`,
        ["product#5"],
        chunkWithStatus(status),
        true,
      );
    }

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still warns for a chunk explicitly pending or blocked", () => {
    warnAwaitedSsrSuspension(
      "sidecar#6",
      ["product#6"],
      chunkWithStatus("pending"),
      true,
    );
    warnAwaitedSsrSuspension(
      "sidecar#6b",
      ["product#6"],
      chunkWithStatus("blocked"),
      true,
    );

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("is compiled out in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    warnAwaitedSsrSuspension("sidecar#7", ["product#7"], pendingStream(), true);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
