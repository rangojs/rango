import { describe, expect, it, vi } from "vitest";

// Collects describe titles and test titles instead of registering them.
const registered = vi.hoisted(() => ({
  describes: [] as string[],
  tests: [] as string[],
}));

vi.mock("@playwright/test", () => {
  const test = Object.assign(
    (title: string) => {
      registered.tests.push(title);
    },
    {
      describe: (title: string, body: () => void) => {
        registered.describes.push(title);
        body();
      },
      setTimeout: () => {},
    },
  );
  return { test, expect: () => {} };
});

describe("describeSuspenseCases", () => {
  it("drives the title and the fixture with one mode, so a (production) describe always gets the build fixture", async () => {
    const { describeSuspenseCases } = await import("./suspense-cases.js");
    for (const [mode, title] of [
      ["dev", "suspense cases (dev)"],
      ["build", "suspense cases (production)"],
    ] as const) {
      let fixtureMode: string | undefined;
      describeSuspenseCases(
        mode,
        async () => {},
        (m) => {
          fixtureMode = m;
          return { url: (pathname) => pathname };
        },
      );
      expect(registered.describes.at(-1)).toBe(title);
      expect(fixtureMode).toBe(mode);
    }
    expect(registered.tests.length).toBeGreaterThan(0);
  });
});
