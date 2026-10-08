import {
  test,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Console guard for dev e2e runs. Every dev test records the browser's
 * warnings, errors and page errors; a message on the deny list fails the
 * test unless the test declared it (expectConsole) or the baseline lists it
 * (tools/e2e-console-baseline.json). A declared or baselined message that did
 * not occur fails too, so neither list goes stale. A message no rule knows is
 * never dropped: it goes to the test's annotations and to the run's summary.
 *
 * Installed by each app's useFixture() for `mode: "dev"`, so no test opts in.
 * React's warnings and the router's suspense audit exist only in a dev build.
 */

export interface ConsoleRule {
  id: string;
  pattern: RegExp;
  /** Deny only at this level. Default: warnings, errors and page errors. */
  level?: "error";
  /** Test files the rule does not apply to. */
  exceptFiles?: RegExp;
}

export const CONSOLE_DENY_RULES: readonly ConsoleRule[] = [
  {
    id: "react-uncached-promise",
    pattern: /A component was suspended by an uncached promise/,
  },
  {
    id: "react-update-while-rendering",
    pattern:
      /Cannot update a component.*while rendering a different component/s,
  },
  {
    id: "react-hydration-mismatch",
    pattern:
      /Hydration failed|hydration mismatch|Text content does not match|didn't match the client|did not match|server rendered HTML/i,
  },
  { id: "react-max-update-depth", pattern: /Maximum update depth exceeded/ },
  {
    id: "react-sync-suspend",
    pattern: /A component suspended while responding to synchronous input/,
  },
  {
    id: "react-use-not-called",
    pattern:
      /called use\(\) to suspend in a previous render but did not call use\(\)/,
  },
  {
    id: "react-key",
    pattern:
      /Each child in a list should have a unique "key" prop|Encountered two children with the same key/,
  },
  { id: "suspense-swap", pattern: /\[rango\]\[suspense\] I1 / },
  { id: "suspense-untracked", pattern: /\[rango\]\[suspense\] I2 / },
  {
    id: "suspense-idle-fallback",
    pattern: /\[rango\]\[suspense\] I3 idle-fallback/,
  },
  {
    id: "suspense-resuspended",
    pattern: /\[rango\]\[suspense\] I3 resuspended/,
  },
  { id: "suspense-remount", pattern: /\[rango\]\[suspense\] I4 / },
  { id: "suspense-drift", pattern: /\[rango\]\[suspense\] I5 / },
  {
    id: "suspense-uncaused",
    pattern: /\[rango\]\[suspense\] I6 /,
  },
  {
    id: "suspense-mutated",
    pattern: /\[rango\]\[suspense\] I7 /,
  },
  {
    id: "rango-tree-structure",
    pattern: /\[Rango\] (Tree structure|MountContextProvider) mismatch/,
  },
  {
    id: "rango-refetch-all",
    pattern: /Missing \d+ segments\. Refetching all/,
    exceptFiles: /hmr/,
  },
  {
    id: "rango-error",
    level: "error",
    pattern:
      /\[(rango|Rango|Browser|RSC|NavigationProvider|RootErrorBoundary|ErrorBoundary)\]/,
  },
];

export type ConsoleGuardMode = "enforce" | "record" | "off";

/** `RANGO_CONSOLE_GUARD`: enforce (default), record (never fails), off. */
export function consoleGuardMode(): ConsoleGuardMode {
  const value = process.env.RANGO_CONSOLE_GUARD;
  return value === "record" || value === "off" ? value : "enforce";
}

export interface ConsoleBaselineEntry {
  app: string;
  /** `<file> > <describe> > <title>`, as Playwright's titlePath joins it. */
  test: string;
  rule: string;
  reason: string;
  /** The message depends on timing: its absence does not fail the test. */
  intermittent?: boolean;
}

export const CONSOLE_BASELINE_PATH: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tools/e2e-console-baseline.json",
);

let baseline: Map<string, ConsoleBaselineEntry[]> | undefined;

function loadBaseline(): Map<string, ConsoleBaselineEntry[]> {
  if (baseline) return baseline;
  baseline = new Map();
  let entries: ConsoleBaselineEntry[] = [];
  try {
    entries = JSON.parse(readFileSync(CONSOLE_BASELINE_PATH, "utf8")).entries;
  } catch {
    // No baseline: every denied message fails.
  }
  for (const entry of entries) {
    const key = `${entry.app}|${entry.test}`;
    const list = baseline.get(key);
    if (list) list.push(entry);
    else baseline.set(key, [entry]);
  }
  return baseline;
}

interface Recorded {
  type: string;
  text: string;
  rule?: string;
  disposition: "denied" | "allowed" | "baseline" | "unknown";
}

interface GuardState {
  app: string;
  enforce: boolean;
  messages: Recorded[];
  allow: Array<{ pattern: RegExp; hits: number }>;
  contexts: WeakSet<BrowserContext>;
  finished: boolean;
}

const states = new WeakMap<TestInfo, GuardState>();

function testName(testInfo: TestInfo): string {
  return testInfo.titlePath.join(" > ");
}

function summaryDir(testInfo: TestInfo): string {
  return (
    process.env.RANGO_CONSOLE_GUARD_DIR ??
    path.join(testInfo.project.outputDir, "console-guard")
  );
}

function append(testInfo: TestInfo, file: string, line: unknown): void {
  const dir = summaryDir(testInfo);
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, file), JSON.stringify(line) + "\n");
}

function ruleFor(
  type: string,
  text: string,
  file: string,
): ConsoleRule | undefined {
  for (const rule of CONSOLE_DENY_RULES) {
    if (rule.level === "error" && type === "warning") continue;
    if (rule.exceptFiles?.test(file)) continue;
    if (rule.pattern.test(text)) return rule;
  }
  return undefined;
}

function record(
  testInfo: TestInfo,
  state: GuardState,
  type: string,
  text: string,
): void {
  if (state.finished) return;
  if (type !== "warning" && type !== "error" && type !== "pageerror") {
    // A debug run keeps the router's own log lines beside the warnings.
    if (process.env.RANGO_CONSOLE_GUARD_DEBUG) {
      append(testInfo, "debug.jsonl", {
        test: testName(testInfo),
        project: testInfo.project.name,
        type,
        text,
      });
    }
    return;
  }
  const rule = ruleFor(type, text, testInfo.file);
  const recorded: Recorded = { type, text, disposition: "unknown" };
  if (rule) {
    recorded.rule = rule.id;
    recorded.disposition = "denied";
    const allowed = state.allow.find((a) => a.pattern.test(text));
    if (allowed) {
      allowed.hits += 1;
      recorded.disposition = "allowed";
    } else if (
      loadBaseline()
        .get(`${state.app}|${testName(testInfo)}`)
        ?.some((entry) => entry.rule === rule.id)
    ) {
      recorded.disposition = "baseline";
    }
  }
  state.messages.push(recorded);
}

/** Record a context the test created itself (`browser.newContext()`). */
export function guardContext(context: BrowserContext): void {
  const testInfo = test.info();
  const state = states.get(testInfo);
  if (!state || state.contexts.has(context)) return;
  state.contexts.add(context);
  context.on("console", (message: ConsoleMessage) => {
    record(testInfo, state, message.type(), message.text());
  });
  context.on("weberror", (webError) => {
    record(testInfo, state, "pageerror", String(webError.error()));
  });
}

/**
 * Declare the denied messages this test provokes on purpose. Each pattern
 * must match at least one message, or the test fails.
 */
export function expectConsole(page: Page, options: { allow: RegExp[] }): void {
  const state = states.get(test.info());
  if (!state) return;
  guardContext(page.context());
  for (const pattern of options.allow) state.allow.push({ pattern, hits: 0 });
}

function finish(testInfo: TestInfo, state: GuardState): void {
  if (state.finished) return;
  state.finished = true;
  const name = testName(testInfo);
  const problems: string[] = [];
  const seenRules = new Set<string>();
  const annotated = new Set<string>();
  // Every test, so a recorded run can tell a quiet test from one that did
  // not run (tools/check-e2e-console-baseline.mjs --from).
  append(testInfo, "tests.jsonl", {
    app: state.app,
    project: testInfo.project.name,
    test: name,
    status: testInfo.status,
  });
  for (const message of state.messages) {
    append(testInfo, "messages.jsonl", {
      app: state.app,
      project: testInfo.project.name,
      test: name,
      status: testInfo.status,
      ...message,
      text: message.text.slice(0, 2000),
    });
    if (message.rule) seenRules.add(message.rule);
    if (message.disposition === "denied") {
      problems.push(`[${message.rule}] ${message.text.slice(0, 500)}`);
    } else if (message.disposition === "unknown") {
      const line = `[${message.type}] ${message.text.slice(0, 300)}`;
      if (annotated.size < 10 && !annotated.has(line)) {
        annotated.add(line);
        testInfo.annotations.push({ type: "console", description: line });
      }
    }
  }
  // Only a test that ran to its end can say a message no longer occurs.
  if (testInfo.status === "passed") {
    for (const allowed of state.allow) {
      if (allowed.hits === 0) {
        problems.push(
          `expectConsole allowed ${allowed.pattern} but no such message occurred: remove it`,
        );
      }
    }
    const entries = loadBaseline().get(`${state.app}|${name}`) ?? [];
    for (const entry of entries) {
      if (!entry.intermittent && !seenRules.has(entry.rule)) {
        problems.push(
          `tools/e2e-console-baseline.json lists [${entry.rule}] for this test but it did not occur: remove the entry`,
        );
      }
    }
  }
  if (state.enforce && problems.length > 0 && testInfo.status === "passed") {
    throw new Error(
      `Console guard (${problems.length}):\n${[...new Set(problems)].join("\n")}\n` +
        `Declare a message the test provokes on purpose with expectConsole(page, { allow }).`,
    );
  }
}

/**
 * Register the guard for the describe being collected. Idempotent per test:
 * nested describes may each call useFixture().
 */
export function installConsoleGuard(options: { app: string }): void {
  const mode = consoleGuardMode();
  if (mode === "off") return;
  test.beforeEach(async ({ context }, testInfo) => {
    if (states.has(testInfo)) return;
    states.set(testInfo, {
      app: options.app,
      // HMR suites edit source under a running page: recorded, not enforced.
      enforce: mode === "enforce" && !testInfo.project.name.startsWith("hmr"),
      messages: [],
      allow: [],
      contexts: new WeakSet(),
      finished: false,
    });
    guardContext(context);
  });
  test.afterEach(async ({}, testInfo) => {
    const state = states.get(testInfo);
    if (state) finish(testInfo, state);
  });
}

export interface SuspenseAuditCounters {
  swaps: number;
  untracked: number;
  idleFallbacks: number;
  resuspended: number;
  remounts: number;
  drifts: number;
  uncaused: number;
  mutations: number;
  /** Not a violation: tree updates React was handed, by cause. */
  treeUpdates: Record<string, number>;
  /** Not a violation: distinct thenables each boundary or read was handed. */
  handed: Record<string, number>;
  /** Not a violation: fallbacks over content on screen while data was pending. */
  shownWhilePending: number;
  events: Array<{ kind: string; boundary: string; detail: string }>;
}

/**
 * The router's dev-only suspense audit counters (src/suspense-audit.ts), or
 * null in a build, which carries no audit.
 */
export async function readSuspenseAudit(
  page: Page,
): Promise<SuspenseAuditCounters | null> {
  return page.evaluate(() => {
    const audit = (
      window as unknown as { __rangoSuspenseAudit?: SuspenseAuditCounters }
    ).__rangoSuspenseAudit;
    if (!audit) return null;
    return {
      swaps: audit.swaps,
      untracked: audit.untracked,
      idleFallbacks: audit.idleFallbacks,
      resuspended: audit.resuspended,
      remounts: audit.remounts,
      drifts: audit.drifts,
      uncaused: audit.uncaused,
      mutations: audit.mutations,
      treeUpdates: { ...audit.treeUpdates },
      handed: { ...audit.handed },
      shownWhilePending: audit.shownWhilePending,
      events: audit.events.map((e) => ({
        kind: e.kind,
        boundary: e.boundary,
        detail: e.detail,
      })),
    };
  });
}

/** Zero the audit's counters, so a test asserts only what follows. */
export async function resetSuspenseAudit(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as { __rangoSuspenseAudit?: { reset(): void } }
    ).__rangoSuspenseAudit?.reset();
  });
}
