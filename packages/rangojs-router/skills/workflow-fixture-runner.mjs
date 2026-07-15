import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const WORKFLOW_FIXTURES = new Set([
  "dev-loop",
  "render-cache-adoption",
  "render-cache-optimizer",
  "stale-data-debugger",
]);

function run(cwd, projects, fixture) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "e2e/mcp.test.ts",
      ...projects.flatMap((project) => ["--project", project]),
      "--no-deps",
      "--retries=0",
    ],
    {
      cwd,
      stdio: "inherit",
      env: { ...process.env, RANGO_WORKFLOW_FIXTURE: fixture },
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function verifyWorkflowFixture(fixture) {
  if (!WORKFLOW_FIXTURES.has(fixture)) {
    throw new Error(`Unknown workflow fixture: ${fixture}`);
  }
  const root = resolve(import.meta.dirname, "../../..");
  run(resolve(root, "packages/rangojs-router"), ["dev", "production"], fixture);
  run(resolve(root, "tests/cloudflare-basic"), ["dev", "production"], fixture);
}
