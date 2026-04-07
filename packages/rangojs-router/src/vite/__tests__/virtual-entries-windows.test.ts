import { describe, it, expect } from "vitest";
import { createVirtualEntriesPlugin } from "../utils/shared-utils.js";
import { VIRTUAL_IDS } from "../plugins/virtual-entries.js";

describe("createVirtualEntriesPlugin Windows path normalization", () => {
  it("normalizes backslashes in routerPathRef.path for RSC virtual entry", () => {
    const routerPathRef = { path: ".\\src\\router.tsx" };
    const plugin = createVirtualEntriesPlugin(
      { client: "client.tsx", ssr: "ssr.tsx", rsc: VIRTUAL_IDS.rsc },
      routerPathRef,
    );

    // Call the load hook with the resolved RSC virtual ID
    const load = (plugin as any).load as (id: string) => string | null;
    const result = load("\0" + VIRTUAL_IDS.rsc);

    expect(result).toBeTruthy();
    // The import specifier must use forward slashes, not backslashes
    expect(result).toContain('from "/src/router.tsx"');
    expect(result).not.toContain("\\");
  });

  it("normalizes backslashes in absolute routerPathRef.path", () => {
    const routerPathRef = { path: "C:\\Users\\dev\\project\\src\\router.tsx" };
    const plugin = createVirtualEntriesPlugin(
      { client: "client.tsx", ssr: "ssr.tsx", rsc: VIRTUAL_IDS.rsc },
      routerPathRef,
    );

    const load = (plugin as any).load as (id: string) => string | null;
    const result = load("\0" + VIRTUAL_IDS.rsc);

    expect(result).toBeTruthy();
    expect(result).toContain('from "C:/Users/dev/project/src/router.tsx"');
    expect(result).not.toContain("\\");
  });
});
