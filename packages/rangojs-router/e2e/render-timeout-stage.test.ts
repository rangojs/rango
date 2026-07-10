import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

interface ErrorRecord {
  phase: string;
  metadata?: {
    render?: Record<string, unknown>;
  };
}

async function readRenderTimeout(
  request: import("@playwright/test").APIRequestContext,
  url: string,
): Promise<ErrorRecord | undefined> {
  const response = await request.get(url);
  const log = (await response.json()) as ErrorRecord[] | null;
  return log?.find(
    (entry) =>
      entry.phase === "handler" && entry.metadata?.render !== undefined,
  );
}

function defineRenderTimeoutStageSuite(mode: "dev" | "build"): void {
  const title =
    mode === "build"
      ? "render timeout stage (production)"
      : "render timeout stage";
  test.describe(title, () => {
    test.setTimeout(90000);
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
      isolatedServer: true,
      // Opt this dedicated server into the 15s renderStartMs timeout + render
      // diagnostics that router.tsx gates behind this env var. The shared
      // webServer leaves them off, so unrelated suites can't 504 on a slow cold
      // render. Reaches both the dev server and the build-mode preview process
      // (fixture merges cliOptions.env into the spawned server's env), and the
      // gate is a runtime read so the reused shared build still honors it.
      cliOptions: { env: { RANGO_E2E_RENDER_TIMEOUT: "1" } },
    });

    test("reports the active HTML operation", async ({ request }) => {
      await request.get(f.url("/__test/clear-error-log"));
      const response = await request.get(f.url("/?__render_timeout_stage=1"), {
        headers: { Accept: "text/html" },
        timeout: 30000,
      });
      expect(response.status()).toBe(504);

      let record: ErrorRecord | undefined;
      await expect
        .poll(async () => {
          record = await readRenderTimeout(
            request,
            f.url("/__test/last-error"),
          );
          return record?.metadata?.render;
        })
        .toMatchObject({
          mode: "full",
          phase: "html",
          state: "running",
          completed: 1,
          total: 3,
        });
    });
  });
}

defineRenderTimeoutStageSuite("dev");
defineRenderTimeoutStageSuite("build");
