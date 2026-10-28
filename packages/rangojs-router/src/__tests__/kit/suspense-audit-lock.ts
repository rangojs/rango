import { afterEach, beforeEach, expect } from "vitest";
import type { SuspenseAuditInstance } from "../../suspense-audit.js";

/**
 * Setup file of the router's unit suite (vitest.config.ts): each test starts
 * with no suspense-audit records, and a test the audit reports a violation in
 * fails (docs/internal/suspense-contract.md, "The unit-test lock").
 *
 * Imports no router module at runtime. A setup file is evaluated before the
 * test file, so a module it loaded would be evaluated before the test file's
 * own setup: logging.test.ts stubs INTERNAL_RANGO_DEBUG and then imports
 * logging.ts, and internal-debug.ts reads the variable once, when it is
 * evaluated. The audit is reached through the instances it lists on window
 * once it has run in this file (suspense-audit.ts SuspenseAuditInstance); with
 * the flag off it never does, and nothing here creates one.
 */

let allowedInFile: string | undefined;
let allowedInTest: string | undefined;

function auditInstances(): SuspenseAuditInstance[] {
  if (typeof window === "undefined") return [];
  return (
    (window as unknown as { __rangoSuspenseAudits?: SuspenseAuditInstance[] })
      .__rangoSuspenseAudits ?? []
  );
}

/**
 * Lets the audit report violations without failing the test. Called at a
 * file's top level, for every test in it, which may or may not report one:
 * a file that provokes them on purpose. Called inside a test, for that test,
 * which must then report one: the entry goes once it stops firing. `reason`
 * names why, and a known router defect by its ticket.
 */
export function allowSuspenseAuditViolations(reason: string): void {
  if (reason.trim() === "") {
    throw new Error("allowSuspenseAuditViolations: name the reason");
  }
  if (expect.getState().currentTestName === undefined) allowedInFile = reason;
  else allowedInTest = reason;
}

beforeEach(() => {
  allowedInTest = undefined;
  for (const instance of auditInstances()) instance.forget();
});

afterEach(async () => {
  const instances = auditInstances();
  await Promise.all(instances.map((instance) => instance.settle()));
  if (allowedInFile !== undefined) return;
  const found = instances
    .map((instance) => instance.violations())
    .filter((text) => text !== undefined)
    .join("\n");
  if (allowedInTest !== undefined) {
    if (found === "") {
      throw new Error(
        `This test is allowed suspense-audit violations ("${allowedInTest}") ` +
          `and reported none: remove the allowance.`,
      );
    }
    return;
  }
  if (found !== "") {
    throw new Error(
      `The suspense audit reported a violation in this test ` +
        `(docs/internal/suspense-contract.md):\n${found}`,
    );
  }
});
