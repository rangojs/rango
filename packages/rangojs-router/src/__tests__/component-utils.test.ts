import { describe, it, expect } from "vitest";
import { isClientComponent, assertClientComponent } from "../component-utils";

describe("component-utils", () => {
  describe("isClientComponent", () => {
    it("should return false for regular functions", () => {
      const ServerComponent = () => null;
      expect(isClientComponent(ServerComponent)).toBe(false);
    });

    it("should return false for non-functions", () => {
      expect(isClientComponent(null)).toBe(false);
      expect(isClientComponent(undefined)).toBe(false);
      expect(isClientComponent("string")).toBe(false);
      expect(isClientComponent(123)).toBe(false);
      expect(isClientComponent({})).toBe(false);
    });

    it("should return true for functions with client reference marker", () => {
      const ClientComponent = () => null;
      // Simulate what the bundler does for "use client" components
      (ClientComponent as any).$$typeof = Symbol.for("react.client.reference");
      (ClientComponent as any).$$id = "src/components/MyComponent.tsx#default";

      expect(isClientComponent(ClientComponent)).toBe(true);
    });

    it("should return false for functions with wrong $$typeof symbol", () => {
      const Component = () => null;
      (Component as any).$$typeof = Symbol.for("react.element");

      expect(isClientComponent(Component)).toBe(false);
    });
  });

  describe("assertClientComponent", () => {
    it("should throw for non-function values", () => {
      expect(() => assertClientComponent(null, "document")).toThrow(
        'document must be a client component function with "use client" directive',
      );

      expect(() => assertClientComponent({}, "document")).toThrow(
        'document must be a client component function with "use client" directive',
      );
    });

    it("should throw for server components (no client marker)", () => {
      const ServerComponent = () => null;

      expect(() => assertClientComponent(ServerComponent, "document")).toThrow(
        'document must be a client component with "use client" directive',
      );
      expect(() => assertClientComponent(ServerComponent, "document")).toThrow(
        "cannot be serialized in the RSC payload",
      );
    });

    it("should not throw for client components", () => {
      const ClientComponent = () => null;
      (ClientComponent as any).$$typeof = Symbol.for("react.client.reference");
      (ClientComponent as any).$$id = "src/document.tsx#default";

      expect(() =>
        assertClientComponent(ClientComponent, "document"),
      ).not.toThrow();
    });

    it("should include component name in error message", () => {
      const ServerComponent = () => null;

      expect(() => assertClientComponent(ServerComponent, "myLayout")).toThrow(
        "myLayout must be a client component",
      );
    });
  });
});
