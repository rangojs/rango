import { describe, it, expect } from "vitest";
import {
  HEAD_RESOLVE_HANDLE_NAMES,
  hasDeferredHandleValue,
  resolveDeferredHandleValues,
} from "../deferred-handle-resolution.js";
import type { HandleData } from "../../types.js";

const META = "__rsc_router_meta__";
const BREADCRUMBS = "__rsc_router_breadcrumbs__";

describe("deferred-handle-resolution", () => {
  describe("hasDeferredHandleValue", () => {
    it("detects a deferred value with no scope (any handle)", () => {
      const data: HandleData = {
        [BREADCRUMBS]: { S0: [Promise.resolve({ label: "x", href: "/x" })] },
      };
      expect(hasDeferredHandleValue(data)).toBe(true);
    });

    it("returns false for an all-sync snapshot", () => {
      const data: HandleData = {
        [META]: { S0: [{ title: "T" }] },
        [BREADCRUMBS]: { S0: [{ label: "x", href: "/x" }] },
      };
      expect(hasDeferredHandleValue(data)).toBe(false);
      expect(hasDeferredHandleValue(data, HEAD_RESOLVE_HANDLE_NAMES)).toBe(
        false,
      );
    });

    it("scoped to Meta: sees a deferred Meta", () => {
      const data: HandleData = {
        [META]: { S0: [Promise.resolve({ title: "Late" })] },
        [BREADCRUMBS]: { S0: [{ label: "x", href: "/x" }] },
      };
      expect(hasDeferredHandleValue(data, HEAD_RESOLVE_HANDLE_NAMES)).toBe(
        true,
      );
    });

    it("scoped to Meta: ignores a deferred non-Meta handle", () => {
      const data: HandleData = {
        [META]: { S0: [{ title: "T" }] },
        [BREADCRUMBS]: { S0: [Promise.resolve({ label: "x", href: "/x" })] },
      };
      // A deferred Breadcrumb is NOT in scope, so the gate does not fire.
      expect(hasDeferredHandleValue(data, HEAD_RESOLVE_HANDLE_NAMES)).toBe(
        false,
      );
      // But unscoped it would.
      expect(hasDeferredHandleValue(data)).toBe(true);
    });
  });

  describe("resolveDeferredHandleValues scoped to Meta", () => {
    it("resolves ONLY Meta, leaves the Breadcrumbs promise intact, passes sync through", async () => {
      const metaPromise = Promise.resolve({ title: "Resolved Title" });
      const crumbPromise = Promise.resolve({ label: "Late", href: "/late" });
      const data: HandleData = {
        [META]: {
          S0: [metaPromise],
          // a sync Meta descriptor in another segment must pass through
          S1: [{ title: "Sync Meta" }],
        },
        [BREADCRUMBS]: {
          // a deferred breadcrumb (defer()) and a sync one
          S0: [crumbPromise, { label: "Home", href: "/" }],
        },
      };

      const out = await resolveDeferredHandleValues(
        data,
        HEAD_RESOLVE_HANDLE_NAMES,
      );

      // Meta deferred value is now resolved to its concrete shape.
      expect(out[META].S0).toEqual([{ title: "Resolved Title" }]);
      // Sync Meta in another segment passed through unchanged.
      expect(out[META].S1).toEqual([{ title: "Sync Meta" }]);

      // Breadcrumbs bucket is passed through by REFERENCE — the deferred entry
      // is STILL the same Promise (the consumer narrows it via isThenable), and
      // the sync entry is untouched.
      expect(out[BREADCRUMBS]).toBe(data[BREADCRUMBS]);
      expect(out[BREADCRUMBS].S0[0]).toBe(crumbPromise);
      expect(out[BREADCRUMBS].S0[1]).toEqual({ label: "Home", href: "/" });
    });

    it("drops a rejected Meta deferred (contributes nothing)", async () => {
      const data: HandleData = {
        [META]: {
          S0: [Promise.reject(new Error("boom")), { title: "Kept" }],
        },
      };
      const out = await resolveDeferredHandleValues(
        data,
        HEAD_RESOLVE_HANDLE_NAMES,
      );
      // Rejected promise dropped; the sync descriptor survives.
      expect(out[META].S0).toEqual([{ title: "Kept" }]);
    });
  });

  describe("resolveDeferredHandleValues without scope (whole snapshot)", () => {
    it("resolves every handle's deferred values", async () => {
      const data: HandleData = {
        [META]: { S0: [Promise.resolve({ title: "M" })] },
        [BREADCRUMBS]: {
          S0: [Promise.resolve({ label: "B", href: "/b" })],
        },
      };
      const out = await resolveDeferredHandleValues(data);
      expect(out[META].S0).toEqual([{ title: "M" }]);
      expect(out[BREADCRUMBS].S0).toEqual([{ label: "B", href: "/b" }]);
    });
  });
});
