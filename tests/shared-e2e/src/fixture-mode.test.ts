import { describe, expect, it } from "vitest";
import {
  assertFixtureModeMatchesProject,
  projectFixtureMode,
  type FixtureModeProject,
  type FixtureModeTestInfo,
} from "./fixture-mode.js";

// The grep shapes the repo's playwright configs use.
const DEV_GREP = /^(?!.*\(production\))/;
const DEV_GREP_OPEN = /^(?!.*\(production)/;
const PRODUCTION_GREP = /\(production\)/;
const PRODUCTION_GREP_OPEN = /\(production/;
// Playwright fills a project without grep with /.*/.
const NO_GREP = /.*/;

function project(
  name: string,
  grep: RegExp | RegExp[],
  grepInvert?: RegExp | RegExp[] | null,
): FixtureModeProject {
  return { name, grep, grepInvert };
}

function testInfo(
  proj: FixtureModeProject,
  describes: string[] = ["thing (production)"],
): FixtureModeTestInfo {
  // [file, ...describes, first test of the beforeAll's group]
  return {
    titlePath: ["thing.test.ts", ...describes, "first test"],
    project: proj,
  };
}

describe("projectFixtureMode", () => {
  it("reads the mode off the grep each config uses", () => {
    expect(projectFixtureMode(project("dev", DEV_GREP))).toBe("dev");
    expect(projectFixtureMode(project("dev", DEV_GREP_OPEN))).toBe("dev");
    expect(projectFixtureMode(project("p", PRODUCTION_GREP))).toBe("build");
    expect(projectFixtureMode(project("p", PRODUCTION_GREP_OPEN))).toBe(
      "build",
    );
  });

  it("buckets no mode for a project that accepts every title", () => {
    expect(projectFixtureMode(project("hmr", NO_GREP))).toBeUndefined();
    expect(projectFixtureMode(project("smoke", NO_GREP, null))).toBeUndefined();
  });

  it("buckets no mode for a project that accepts neither probe", () => {
    expect(projectFixtureMode(project("x", /^never$/))).toBeUndefined();
  });

  it("reads grep arrays and grepInvert", () => {
    expect(projectFixtureMode(project("p", [/zzz/, PRODUCTION_GREP]))).toBe(
      "build",
    );
    expect(projectFixtureMode(project("d", NO_GREP, PRODUCTION_GREP))).toBe(
      "dev",
    );
    expect(projectFixtureMode(project("d", NO_GREP, [PRODUCTION_GREP]))).toBe(
      "dev",
    );
  });

  it("is not thrown off by a global regexp's lastIndex", () => {
    const grep = /\(production\)/g;
    for (let i = 0; i < 3; i++) {
      expect(projectFixtureMode(project("p", grep))).toBe("build");
    }
  });
});

describe("assertFixtureModeMatchesProject", () => {
  it("accepts a fixture whose mode is its project's mode", () => {
    expect(() =>
      assertFixtureModeMatchesProject(
        "dev",
        testInfo(project("dev", DEV_GREP), ["thing"]),
      ),
    ).not.toThrow();
    expect(() =>
      assertFixtureModeMatchesProject(
        "build",
        testInfo(project("production", PRODUCTION_GREP)),
      ),
    ).not.toThrow();
  });

  it("throws for a build fixture in a dev project, naming describe, project and mode", () => {
    const run = () =>
      assertFixtureModeMatchesProject(
        "build",
        testInfo(project("dev", DEV_GREP), ["outer", "inner (prod)"]),
      );
    expect(run).toThrow(/describe "outer > inner \(prod\)"/);
    expect(run).toThrow(/"build" fixture/);
    expect(run).toThrow(/project "dev"/);
    expect(run).toThrow(/runs "dev" fixtures/);
    expect(run).toThrow(/add "\(production\)"/);
  });

  it("throws for a dev fixture in a production project", () => {
    const run = () =>
      assertFixtureModeMatchesProject(
        "dev",
        testInfo(project("production", PRODUCTION_GREP)),
      );
    expect(run).toThrow(/"dev" fixture/);
    expect(run).toThrow(/project "production"/);
    expect(run).toThrow(/runs "build" fixtures/);
    expect(run).toThrow(/remove "\(production\)"/);
  });

  it("names a file-level fixture, which has no describe", () => {
    expect(() =>
      assertFixtureModeMatchesProject(
        "build",
        testInfo(project("dev", DEV_GREP), []),
      ),
    ).toThrow(/describe "\(file level\)"/);
  });

  it("skips a fixture with no mode and a project that buckets none", () => {
    expect(() =>
      assertFixtureModeMatchesProject(
        undefined,
        testInfo(project("dev", DEV_GREP)),
      ),
    ).not.toThrow();
    expect(() =>
      assertFixtureModeMatchesProject(
        "build",
        testInfo(project("hmr", NO_GREP)),
      ),
    ).not.toThrow();
  });
});
