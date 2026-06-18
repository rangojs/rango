import { describe, expect, it } from "vitest";

import { escapeRegExp } from "../regex-escape.js";

describe("escapeRegExp", () => {
  it("escapes each regex metacharacter", () => {
    expect(escapeRegExp(".")).toBe("\\.");
    expect(escapeRegExp("*")).toBe("\\*");
    expect(escapeRegExp("+")).toBe("\\+");
    expect(escapeRegExp("?")).toBe("\\?");
    expect(escapeRegExp("^")).toBe("\\^");
    expect(escapeRegExp("$")).toBe("\\$");
    expect(escapeRegExp("{")).toBe("\\{");
    expect(escapeRegExp("}")).toBe("\\}");
    expect(escapeRegExp("(")).toBe("\\(");
    expect(escapeRegExp(")")).toBe("\\)");
    expect(escapeRegExp("|")).toBe("\\|");
    expect(escapeRegExp("[")).toBe("\\[");
    expect(escapeRegExp("]")).toBe("\\]");
    expect(escapeRegExp("\\")).toBe("\\\\");
  });

  it("leaves safe strings unchanged", () => {
    expect(escapeRegExp("myLoader")).toBe("myLoader");
    expect(escapeRegExp("foo-bar_42")).toBe("foo-bar_42");
  });

  it("round-trips as a literal inside a RegExp", () => {
    const re = new RegExp("^" + escapeRegExp("a.b") + "$");
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
  });
});
