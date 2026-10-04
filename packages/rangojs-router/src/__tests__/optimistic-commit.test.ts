import { describe, expect, it } from "vitest";
import {
  OPTIMISTIC_COMMIT_TRANSITION_TYPE,
  withOptimisticCommitNone,
} from "../browser/optimistic-commit.js";

describe("withOptimisticCommitNone", () => {
  it("maps the optimistic-commit type to none without losing the configured class", () => {
    expect(withOptimisticCommitNone(undefined)).toEqual({
      [OPTIMISTIC_COMMIT_TRANSITION_TYPE]: "none",
    });
    expect(withOptimisticCommitNone("fade")).toEqual({
      default: "fade",
      [OPTIMISTIC_COMMIT_TRANSITION_TYPE]: "none",
    });
    expect(
      withOptimisticCommitNone({ default: "fade", navigation: "slide" }),
    ).toEqual({
      default: "fade",
      navigation: "slide",
      [OPTIMISTIC_COMMIT_TRANSITION_TYPE]: "none",
    });
  });

  it("does not let a consumer class override the none mapping", () => {
    const merged = withOptimisticCommitNone({
      [OPTIMISTIC_COMMIT_TRANSITION_TYPE]: "fade",
    }) as Record<string, string>;
    expect(merged[OPTIMISTIC_COMMIT_TRANSITION_TYPE]).toBe("none");
  });
});
