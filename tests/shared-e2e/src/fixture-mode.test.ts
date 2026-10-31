import { describe, expect, it } from "vitest";
// The plain-JS mirror used by the no-typescript app's harness.
import { assertFixtureModeMatchesProject as mirror } from "../../no-typescript/e2e/fixture-mode.js";
import {
  assertFixtureModeMatchesProject,
  type FixtureModeTestInfo,
} from "./fixture-mode.js";

function testInfo(
  projectName: string,
  fixtureMode: string | undefined,
  describes: string[] = ["thing (production)"],
): FixtureModeTestInfo {
  return {
    titlePath: ["thing.test.ts", ...describes, "beforeAll hook"],
    project: {
      name: projectName,
      metadata: fixtureMode === undefined ? {} : { fixtureMode },
    },
  };
}

describe("assertFixtureModeMatchesProject", () => {
  it("accepts a fixture whose mode is its project's mode", () => {
    expect(() =>
      assertFixtureModeMatchesProject("dev", testInfo("dev", "dev")),
    ).not.toThrow();
    expect(() =>
      assertFixtureModeMatchesProject("build", testInfo("production", "build")),
    ).not.toThrow();
  });

  it("throws for a build fixture in a dev project, naming describe, project and mode", () => {
    const run = () =>
      assertFixtureModeMatchesProject(
        "build",
        testInfo("dev", "dev", ["outer", "inner (prod)"]),
      );
    expect(run).toThrow(/describe "outer > inner \(prod\)"/);
    expect(run).toThrow(/"build" fixture/);
    expect(run).toThrow(/project "dev"/);
    expect(run).toThrow(/add "\(production\)"/);
  });

  it("throws for a dev fixture in a production project", () => {
    const run = () =>
      assertFixtureModeMatchesProject("dev", testInfo("production", "build"));
    expect(run).toThrow(/"dev" fixture/);
    expect(run).toThrow(/project "production"/);
    expect(run).toThrow(/remove "\(production\)"/);
  });

  it("skips a fixture with no mode and a project with no declared mode", () => {
    expect(() =>
      assertFixtureModeMatchesProject(undefined, testInfo("dev", "dev")),
    ).not.toThrow();
    expect(() =>
      assertFixtureModeMatchesProject("build", testInfo("smoke", undefined)),
    ).not.toThrow();
  });
});

describe("no-typescript mirror", () => {
  it("throws the same message as the shared check", () => {
    const cases: Array<["dev" | "build", FixtureModeTestInfo]> = [
      ["build", testInfo("dev", "dev", ["a", "b"])],
      ["dev", testInfo("production", "build")],
    ];
    for (const [mode, info] of cases) {
      const shared = () => assertFixtureModeMatchesProject(mode, info);
      const message = (fn: () => void) => {
        try {
          fn();
        } catch (e) {
          return (e as Error).message;
        }
        return "";
      };
      expect(message(shared)).not.toBe("");
      expect(message(() => mirror(mode, info))).toBe(message(shared));
    }
  });
});
