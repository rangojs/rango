import { describe, it, expect, vi } from "vitest";
import { runBackground } from "../background-task.js";

describe("runBackground", () => {
  it("delegates to host.waitUntil when available", () => {
    const waitUntil = vi.fn();
    const task = vi.fn().mockResolvedValue(undefined);

    const result = runBackground({ waitUntil }, task);

    expect(waitUntil).toHaveBeenCalledWith(task);
    expect(result).toBeUndefined();
  });

  it("skips task when host is null and blockWhenNoWaitUntil is false", () => {
    const task = vi.fn();
    const result = runBackground(null, task);

    expect(task).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("skips task when host has no waitUntil and blockWhenNoWaitUntil is false", () => {
    const task = vi.fn();
    const result = runBackground({}, task);

    expect(task).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("awaits task when host is null and blockWhenNoWaitUntil is true", async () => {
    let ran = false;
    const task = async () => {
      ran = true;
    };

    const result = runBackground(null, task, true);
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(ran).toBe(true);
  });

  it("awaits task when host has no waitUntil and blockWhenNoWaitUntil is true", async () => {
    let ran = false;
    const task = async () => {
      ran = true;
    };

    const result = runBackground({}, task, true);
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(ran).toBe(true);
  });

  it("prefers waitUntil even when blockWhenNoWaitUntil is true", () => {
    const waitUntil = vi.fn();
    const task = vi.fn().mockResolvedValue(undefined);

    runBackground({ waitUntil }, task, true);

    expect(waitUntil).toHaveBeenCalledWith(task);
  });
});
