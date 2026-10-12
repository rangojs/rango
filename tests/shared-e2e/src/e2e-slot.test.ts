import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  e2eSlotLimit,
  isPidAlive,
  liveE2eSlotTickets,
  takeE2eSlotTicket,
} from "./e2e-slot.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-slot-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const runner = ["node", "/x/playwright/cli.js", "test"];

describe("e2eSlotLimit", () => {
  it("defaults to 2 for a local `playwright test` runner", () => {
    expect(e2eSlotLimit(runner, {})).toBe(2);
    expect(e2eSlotLimit([...runner, "--project=dev"], {})).toBe(2);
  });

  it("honours RANGO_E2E_SLOTS, and 0 disables", () => {
    expect(e2eSlotLimit(runner, { RANGO_E2E_SLOTS: "3" })).toBe(3);
    expect(e2eSlotLimit(runner, { RANGO_E2E_SLOTS: "0" })).toBe(0);
    expect(e2eSlotLimit(runner, { RANGO_E2E_SLOTS: "nope" })).toBe(0);
  });

  it("skips CI, workers, --list and other commands", () => {
    expect(e2eSlotLimit(runner, { CI: "true" })).toBe(0);
    expect(e2eSlotLimit(runner, { TEST_WORKER_INDEX: "0" })).toBe(0);
    expect(e2eSlotLimit([...runner, "--list"], {})).toBe(0);
    expect(e2eSlotLimit(["node", "/x/workerProcessEntry.js"], {})).toBe(0);
    expect(e2eSlotLimit(["node", "/x/cli.js", "show-report"], {})).toBe(0);
  });
});

describe("e2e slot queue", () => {
  it("orders tickets by arrival, so the first `limit` run and the rest wait", () => {
    const dir = tempDir();
    const c = takeE2eSlotTicket(dir, 3, "c", 300);
    const a = takeE2eSlotTicket(dir, 1, "a", 100);
    const b = takeE2eSlotTicket(dir, 2, "b", 200);
    const queue = liveE2eSlotTickets(dir, () => true);
    expect(queue.map((t) => t.file)).toEqual([a, b, c]);
  });

  it("sweeps tickets whose process is gone, and the next ticket moves up", () => {
    const dir = tempDir();
    const dead = takeE2eSlotTicket(dir, 11, "dead", 100);
    const live = takeE2eSlotTicket(dir, 12, "live", 200);
    const queue = liveE2eSlotTickets(dir, (pid) => pid !== 11);
    expect(queue.map((t) => t.file)).toEqual([live]);
    expect(existsSync(dead)).toBe(false);
  });

  it("ignores files that are not tickets and a missing directory", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "notes.txt"), "x");
    takeE2eSlotTicket(dir, 1, "a", 100);
    expect(liveE2eSlotTickets(dir, () => true)).toHaveLength(1);
    expect(liveE2eSlotTickets(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("isPidAlive", () => {
  it("is true for this process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("treats EPERM as alive and ESRCH as gone", () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(fail("EPERM"));
    expect(isPidAlive(4242)).toBe(true);
    kill.mockImplementationOnce(fail("ESRCH"));
    expect(isPidAlive(4242)).toBe(false);
  });
});
