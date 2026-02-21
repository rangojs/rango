import type { Plugin } from "vite";

/**
 * Stub plugin that resolves and provides empty exports for virtual modules
 * that the RSC entry may import but aren't needed for route discovery.
 * @internal
 */
export function createVirtualStubPlugin(): Plugin {
  const STUB_PREFIXES = [
    "virtual:rsc-router/",
    "virtual:entry-",
    "virtual:vite-rsc/",
  ];
  return {
    name: "@rangojs/router:virtual-stubs",
    resolveId(id) {
      if (STUB_PREFIXES.some((p) => id.startsWith(p))) {
        return "\0stub:" + id;
      }
      return null;
    },
    load(id) {
      if (id.startsWith("\0stub:")) {
        return "export default {}";
      }
      return null;
    },
  };
}
