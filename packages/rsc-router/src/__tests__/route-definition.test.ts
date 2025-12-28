import { describe, it, expect } from "vitest";
import { route } from "../route-definition";

describe("route()", () => {
  describe("with nested RouteConfig objects", () => {
    it("should flatten nested RouteConfig with trailing slash config", () => {
      const routes = route({
        index: "/",
        trailingSlash: {
          ignore: { path: "/ts-ignore", trailingSlash: "ignore" },
          always: { path: "/ts-always", trailingSlash: "always" },
          never: { path: "/ts-never", trailingSlash: "never" },
        },
      }) as any;

      // Check routes are flattened correctly
      expect(routes.index).toBe("/");
      expect(routes["trailingSlash.ignore"]).toBe("/ts-ignore");
      expect(routes["trailingSlash.always"]).toBe("/ts-always");
      expect(routes["trailingSlash.never"]).toBe("/ts-never");

      // Check trailing slash config is attached
      expect(routes.__trailingSlash).toBeDefined();
      expect(routes.__trailingSlash["trailingSlash.ignore"]).toBe("ignore");
      expect(routes.__trailingSlash["trailingSlash.always"]).toBe("always");
      expect(routes.__trailingSlash["trailingSlash.never"]).toBe("never");
    });

    it("should be enumerable for Object.entries", () => {
      const routes = route({
        index: "/",
        trailingSlash: {
          ignore: { path: "/ts-ignore", trailingSlash: "ignore" },
        },
      });

      const entries = Object.entries(routes);
      expect(entries).toContainEqual(["index", "/"]);
      expect(entries).toContainEqual(["trailingSlash.ignore", "/ts-ignore"]);
    });

    it("should apply global default to string routes", () => {
      const routes = route({
        blog: "/blog",
        about: "/about",
      }, { trailingSlash: "never" }) as any;

      expect(routes.__trailingSlash).toBeDefined();
      expect(routes.__trailingSlash.blog).toBe("never");
      expect(routes.__trailingSlash.about).toBe("never");
    });

    it("should let per-route config override global default", () => {
      const routes = route({
        blog: "/blog",
        api: { path: "/api", trailingSlash: "ignore" },
      }, { trailingSlash: "never" }) as any;

      expect(routes.__trailingSlash.blog).toBe("never");
      expect(routes.__trailingSlash.api).toBe("ignore");
    });
  });
});
