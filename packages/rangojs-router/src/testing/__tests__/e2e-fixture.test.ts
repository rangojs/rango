import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestType } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { createUseFixture } from "../e2e/fixture.js";

/**
 * Drives createUseFixture's hooks by hand, as Playwright would. Playwright
 * does not cancel a timed-out beforeAll: afterAll runs while the hook body
 * keeps going, so a build that finishes after teardown must not go on to
 * start a preview server nobody would stop.
 */

type Hook = (fixtures: object, testInfo: unknown) => Promise<void>;

function fakeTest(): {
  test: TestType<any, any>;
  beforeAll: () => Hook;
  afterAll: () => Hook;
} {
  let before: Hook | undefined;
  let after: Hook | undefined;
  const test = {
    beforeAll: (fn: Hook) => {
      before = fn;
    },
    afterAll: (fn: Hook) => {
      after = fn;
    },
  } as unknown as TestType<any, any>;
  return { test, beforeAll: () => before!, afterAll: () => after! };
}

let dir: string;

afterEach(() => {
  // A preview that started despite the teardown is killed here.
  const marker = path.join(dir, "preview-started");
  if (existsSync(marker)) {
    try {
      process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("createUseFixture", () => {
  it("does not start the preview when the build finishes after afterAll", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "rango-e2e-fixture-"));
    // The build takes a moment, so afterAll runs while it is still going, and
    // it finishes with code 0 although teardown signalled it.
    writeFileSync(
      path.join(dir, "build.mjs"),
      "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 300);",
    );
    // The preview leaves a marker the moment it starts.
    writeFileSync(
      path.join(dir, "preview.mjs"),
      [
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync("preview-started", String(process.pid));`,
        `console.log("http://localhost:1234");`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );
    const { test, beforeAll, afterAll } = fakeTest();
    const useFixture = createUseFixture(test);
    useFixture({
      root: dir,
      mode: "build",
      buildCommand: "node build.mjs",
      command: "node preview.mjs",
      cliOptions: {
        env: {
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    const hook = beforeAll()({}, { project: { name: "test" } });
    // afterAll runs while beforeAll is still awaiting the build, as after a
    // beforeAll timeout.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await afterAll()({}, {});

    await expect(hook).rejects.toThrow(/torn down/);
    // Give a preview that did start time to write its marker.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(path.join(dir, "preview-started"))).toBe(false);
  });
});
