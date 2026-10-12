import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Machine-wide cap on concurrent local `playwright test` runs: one router run
 * starts four Vite servers plus builds, workers and Chromium (about 5 GB).
 * The runner takes a ticket at config load, before its webServers start, and
 * drops it on exit. The first `limit` live tickets run; the rest wait in
 * arrival order. A ticket's name carries its pid, so the ticket of a killed
 * run is swept by the next reader. The directory is shared across checkouts
 * and repos. RANGO_E2E_SLOTS sets the cap (default 2, 0 disables); CI,
 * workers, `--list` and IDE test servers are not capped.
 */

const SLOT_DIR = path.join(os.homedir(), ".cache", "e2e-slots");
const DEFAULT_SLOTS = 2;
const POLL_MS = 2000;
const POLLS_PER_NOTICE = 15;
const TICKET_PATTERN = /^ticket-(\d+)-(\d+)$/;

let heldTicket: string | undefined;

/** Cap for this process, or 0 when it must not take a slot. */
export function e2eSlotLimit(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): number {
  if (env.CI) return 0;
  // Workers re-load the config; the runner already holds the slot.
  if (env.TEST_WORKER_INDEX !== undefined) return 0;
  const args = argv.slice(2);
  if (args[0] !== "test" || args.includes("--list")) return 0;
  const raw = env.RANGO_E2E_SLOTS;
  const limit = raw === undefined || raw === "" ? DEFAULT_SLOTS : Number(raw);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function takeE2eSlotTicket(
  dir: string,
  pid: number,
  note: string,
  now: number = Date.now(),
): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ticket-${String(now).padStart(15, "0")}-${pid}`);
  writeFileSync(file, note);
  return file;
}

/** Live tickets in arrival order; tickets of dead processes are removed. */
export function liveE2eSlotTickets(
  dir: string,
  isAlive: (pid: number) => boolean = isPidAlive,
): { file: string; pid: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: { file: string; pid: number }[] = [];
  for (const name of names.sort()) {
    const match = TICKET_PATTERN.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    const pid = Number(match[2]);
    if (isAlive(pid)) live.push({ file, pid });
    else rmSync(file, { force: true });
  }
  return live;
}

function describeTicket(ticket: { file: string; pid: number }): string {
  try {
    return `pid ${ticket.pid}: ${readFileSync(ticket.file, "utf8")}`;
  } catch {
    return `pid ${ticket.pid}`;
  }
}

/**
 * Call at the top of a playwright.config.ts. Blocks until this run holds one
 * of the machine's e2e slots, printing who holds them while it waits.
 */
export function acquireE2eSlot(label: string): void {
  const limit = e2eSlotLimit(process.argv, process.env);
  if (limit === 0 || heldTicket) return;
  const ticket = takeE2eSlotTicket(
    SLOT_DIR,
    process.pid,
    `${label} (${process.cwd()})`,
  );
  heldTicket = ticket;
  process.on("exit", () => rmSync(ticket, { force: true }));

  const sleepCell = new Int32Array(new SharedArrayBuffer(4));
  for (let polls = 0; ; polls++) {
    const queue = liveE2eSlotTickets(SLOT_DIR);
    const position = queue.findIndex((t) => t.file === ticket);
    if (position < limit) return;
    if (polls % POLLS_PER_NOTICE === 0) {
      console.error(
        [
          `[e2e-slot] "${label}" is waiting for one of ${limit} machine-wide e2e slots (${position - limit + 1} in line).`,
          ...queue
            .slice(0, limit)
            .map((t) => `  running: ${describeTicket(t)}`),
          `  RANGO_E2E_SLOTS=<n> changes the cap; 0 disables it. Tickets: ${SLOT_DIR}`,
        ].join("\n"),
      );
    }
    Atomics.wait(sleepCell, 0, 0, POLL_MS);
  }
}
