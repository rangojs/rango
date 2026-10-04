// When @vitejs/plugin-rsc/transforms fails to load, the rango plugin leaves the
// module unwrapped (unchanged behavior), and rangoUseCacheTransform() throws so
// a test does not silently run every "use cache" function uncached (#939).
import { describe, it, expect, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/transforms", () => {
  throw new Error("transforms unavailable");
});

import { useCacheTransform } from "../plugins/use-cache-transform.js";
import { rangoUseCacheTransform } from "../../testing/vitest.js";

const code = `export async function getData() {
  "use cache";
  return 1;
}
`;

describe("use-cache transform when plugin-rsc's transforms fail to load", () => {
  it("the rango plugin skips the module", async () => {
    const plugin = useCacheTransform() as unknown as {
      configResolved(config: object): void;
      transform(this: object, code: string, id: string): Promise<unknown>;
    };
    plugin.configResolved({ command: "serve", root: "/project" });

    await expect(
      plugin.transform.call(
        { environment: { name: "rsc" }, warn: () => {} },
        code,
        "/project/src/data.ts",
      ),
    ).resolves.toBeUndefined();
  });

  it("rangoUseCacheTransform throws instead of leaving it unwrapped", async () => {
    const helper = rangoUseCacheTransform();
    helper.configResolved({ root: "/project" });

    await expect(
      helper.transform.call({ warn: () => {} }, code, "/project/src/data.ts"),
    ).rejects.toThrow(
      /rangoUseCacheTransform: @vitejs\/plugin-rsc\/transforms failed to load/,
    );
  });
});
