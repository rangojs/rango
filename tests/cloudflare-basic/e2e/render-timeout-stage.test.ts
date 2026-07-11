import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

function renderTimeoutStageSuite(f: ReturnType<typeof useFixture>): void {
  test("reports the active HTML operation", async ({ request }) => {
    const response = await request.get(f.url("/?__render_timeout_stage=1"), {
      headers: { Accept: "text/html" },
      timeout: 30000,
    });
    expect(response.status()).toBe(504);
    expect(await response.json()).toMatchObject({
      mode: "full",
      phase: "html",
      state: "running",
      completed: 1,
      total: 3,
    });
  });
}

test.describe("render timeout stage", () => {
  test.setTimeout(90000);
  const f = useFixture({ root: ".", mode: "dev" });
  renderTimeoutStageSuite(f);
});

test.describe("render timeout stage (production)", () => {
  test.setTimeout(90000);
  const f = useFixture({ root: ".", mode: "build" });
  renderTimeoutStageSuite(f);
});
