// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactNode } from "react";
import type { ResolvedSegment } from "../types.js";

/**
 * Without INTERNAL_RANGO_SUSPENSE_AUDIT, a consumer's dev server and tests:
 * the audit prints nothing, keeps no report, and renderSegments builds the
 * product boundaries (src/internal-suspense-audit.ts).
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (window as { __rangoSuspenseAudit?: unknown }).__rangoSuspenseAudit;
});

function hasType(root: unknown, type: unknown): boolean {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (isValidElement(node)) {
      if (node.type === type) return true;
      stack.push(...Object.values(node.props as Record<string, unknown>));
    }
  }
  return false;
}

it("is silent, keeps no report and builds the product boundaries with the flag off", async () => {
  vi.stubEnv("INTERNAL_RANGO_SUSPENSE_AUDIT", "");
  vi.resetModules();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const audit = await import("../suspense-audit.js");
    const { renderSegments } = await import("../segment-system.js");
    const { AuditedRouteContent, RouteContentWrapper } =
      await import("../route-content-wrapper.js");
    // An update no emitter named a cause for: I6 with the flag on.
    audit.auditTreeUpdate(undefined);
    const segments: ResolvedSegment[] = [
      {
        id: "R0",
        namespace: "",
        index: 0,
        type: "route",
        component: createElement("p", null, "route"),
        loading: createElement("p", null, "loading") as ReactNode,
      },
    ];
    const tree = await renderSegments(segments);
    expect(hasType(tree, RouteContentWrapper)).toBe(true);
    expect(hasType(tree, AuditedRouteContent)).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(
      (window as { __rangoSuspenseAudit?: unknown }).__rangoSuspenseAudit,
    ).toBeUndefined();
  } finally {
    errors.mockRestore();
  }
});
