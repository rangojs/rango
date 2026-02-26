import { describe, it, expect } from "vitest";
import {
  hashId,
  normalizePath,
  detectImports,
  skipStringOrComment,
  findMatchingParen,
  countArgs,
  findStatementEnd,
  buildExportMap,
  escapeRegExp,
} from "../plugins/expose-id-utils.js";

describe("normalizePath", () => {
  it("returns forward-slash paths unchanged", () => {
    expect(normalizePath("src/utils/file.ts")).toBe("src/utils/file.ts");
  });

  it("handles paths with path.sep (platform-dependent)", () => {
    // normalizePath splits on path.sep and joins with "/".
    // On macOS/Linux path.sep is "/" so backslashes pass through unchanged.
    // On Windows path.sep is "\\" so backslashes would be converted.
    const input = ["src", "utils", "file.ts"].join("/");
    expect(normalizePath(input)).toBe("src/utils/file.ts");
  });

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });

  it("handles single component path", () => {
    expect(normalizePath("file.ts")).toBe("file.ts");
  });
});

describe("buildExportMap", () => {
  function makeProgramBody(body: any[]): any {
    return { body };
  }

  it("extracts export const declarations", () => {
    const program = makeProgramBody([
      {
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [{ id: { type: "Identifier", name: "myLoader" } }],
        },
        specifiers: [],
        source: null,
      },
    ]);
    const map = buildExportMap(program);
    expect(map.get("myLoader")).toEqual(["myLoader"]);
  });

  it("extracts export { X } specifiers", () => {
    const program = makeProgramBody([
      {
        type: "ExportNamedDeclaration",
        declaration: null,
        source: null,
        specifiers: [
          {
            type: "ExportSpecifier",
            local: { type: "Identifier", name: "foo" },
            exported: { type: "Identifier", name: "foo" },
          },
        ],
      },
    ]);
    const map = buildExportMap(program);
    expect(map.get("foo")).toEqual(["foo"]);
  });

  it("extracts export { X as Y } renames", () => {
    const program = makeProgramBody([
      {
        type: "ExportNamedDeclaration",
        declaration: null,
        source: null,
        specifiers: [
          {
            type: "ExportSpecifier",
            local: { type: "Identifier", name: "internalName" },
            exported: { type: "Identifier", name: "PublicName" },
          },
        ],
      },
    ]);
    const map = buildExportMap(program);
    expect(map.get("internalName")).toEqual(["PublicName"]);
  });

  it("skips re-exports (export { X } from '...')", () => {
    const program = makeProgramBody([
      {
        type: "ExportNamedDeclaration",
        declaration: null,
        source: { type: "Literal", value: "./other.ts" },
        specifiers: [
          {
            type: "ExportSpecifier",
            local: { type: "Identifier", name: "reExported" },
            exported: { type: "Identifier", name: "reExported" },
          },
        ],
      },
    ]);
    const map = buildExportMap(program);
    expect(map.size).toBe(0);
  });

  it("handles multiple declarations in one export const", () => {
    const program = makeProgramBody([
      {
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            { id: { type: "Identifier", name: "a" } },
            { id: { type: "Identifier", name: "b" } },
          ],
        },
        specifiers: [],
        source: null,
      },
    ]);
    const map = buildExportMap(program);
    expect(map.get("a")).toEqual(["a"]);
    expect(map.get("b")).toEqual(["b"]);
  });

  it("collects multiple export names for same local", () => {
    const program = makeProgramBody([
      {
        type: "ExportNamedDeclaration",
        declaration: null,
        source: null,
        specifiers: [
          {
            type: "ExportSpecifier",
            local: { type: "Identifier", name: "impl" },
            exported: { type: "Identifier", name: "Alias1" },
          },
        ],
      },
      {
        type: "ExportNamedDeclaration",
        declaration: null,
        source: null,
        specifiers: [
          {
            type: "ExportSpecifier",
            local: { type: "Identifier", name: "impl" },
            exported: { type: "Identifier", name: "Alias2" },
          },
        ],
      },
    ]);
    const map = buildExportMap(program);
    expect(map.get("impl")).toEqual(["Alias1", "Alias2"]);
  });

  it("handles empty program body", () => {
    const map = buildExportMap({ body: [] });
    expect(map.size).toBe(0);
  });

  it("handles undefined body", () => {
    const map = buildExportMap({});
    expect(map.size).toBe(0);
  });
});

describe("escapeRegExp", () => {
  it("escapes special regex characters", () => {
    expect(escapeRegExp("$Nav")).toBe("\\$Nav");
    expect(escapeRegExp("foo.bar")).toBe("foo\\.bar");
    expect(escapeRegExp("a+b*c?")).toBe("a\\+b\\*c\\?");
  });

  it("leaves normal strings unchanged", () => {
    expect(escapeRegExp("myLoader")).toBe("myLoader");
  });
});

describe("hashId", () => {
  it("should generate consistent hashes", () => {
    const a = hashId("src/loaders/cart.ts", "CartLoader");
    const b = hashId("src/loaders/cart.ts", "CartLoader");
    expect(a).toBe(b);
  });

  it("should produce 8-char hex prefix + # + export name", () => {
    const id = hashId("src/test.ts", "MyExport");
    expect(id).toMatch(/^[0-9a-f]{8}#MyExport$/);
  });

  it("should produce different hashes for different inputs", () => {
    const a = hashId("src/a.ts", "Loader");
    const b = hashId("src/b.ts", "Loader");
    expect(a).not.toBe(b);
  });

  it("should produce different hashes for different export names", () => {
    const a = hashId("src/a.ts", "LoaderA");
    const b = hashId("src/a.ts", "LoaderB");
    expect(a).not.toBe(b);
  });
});

describe("detectImports", () => {
  it("should detect createLoader from @rangojs/router", () => {
    const code = `import { createLoader } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.loader).toBe(true);
    expect(result.any).toBe(true);
  });

  it("should detect createLoader from @rangojs/router/server", () => {
    const code = `import { createLoader } from "@rangojs/router/server";`;
    const result = detectImports(code);
    expect(result.loader).toBe(true);
  });

  it("should detect createHandle from @rangojs/router", () => {
    const code = `import { createHandle } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.handle).toBe(true);
    expect(result.any).toBe(true);
  });

  it("should detect createLocationState from @rangojs/router", () => {
    const code = `import { createLocationState } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.locationState).toBe(true);
  });

  it("should detect Prerender from @rangojs/router", () => {
    const code = `import { Prerender } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.prerenderHandler).toBe(true);
  });

  it("should detect Static from @rangojs/router", () => {
    const code = `import { Static } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.staticHandler).toBe(true);
    expect(result.any).toBe(true);
  });

  it("should detect Static from @rangojs/router/server", () => {
    const code = `import { Static } from "@rangojs/router/server";`;
    const result = detectImports(code);
    expect(result.staticHandler).toBe(true);
  });

  it("should detect createRouter from @rangojs/router only (not sub-paths)", () => {
    const code = `import { createRouter } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.router).toBe(true);
  });

  it("should NOT detect createRouter from @rangojs/router/server", () => {
    const code = `import { createRouter } from "@rangojs/router/server";`;
    const result = detectImports(code);
    expect(result.router).toBe(false);
  });

  it("should detect multiple imports in one statement", () => {
    const code = `import { createLoader, createHandle, route } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.loader).toBe(true);
    expect(result.handle).toBe(true);
    expect(result.any).toBe(true);
  });

  it("should detect imports across multiple statements", () => {
    const code = `
      import { createLoader } from "@rangojs/router/server";
      import { createHandle } from "@rangojs/router";
    `;
    const result = detectImports(code);
    expect(result.loader).toBe(true);
    expect(result.handle).toBe(true);
  });

  it("should NOT detect imports from other packages", () => {
    const code = `import { createLoader } from "other-package";`;
    const result = detectImports(code);
    expect(result.loader).toBe(false);
    expect(result.any).toBe(false);
  });

  it("should return all false for no relevant imports", () => {
    const code = `import { route, map } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.any).toBe(false);
  });

  it("should handle empty string", () => {
    const result = detectImports("");
    expect(result.any).toBe(false);
    expect(result.loader).toBe(false);
    expect(result.router).toBe(false);
  });
});

describe("skipStringOrComment", () => {
  it("should skip double-quoted strings", () => {
    const code = `"hello world" rest`;
    expect(skipStringOrComment(code, 0)).toBe(13);
  });

  it("should skip single-quoted strings", () => {
    const code = `'hello' rest`;
    expect(skipStringOrComment(code, 0)).toBe(7);
  });

  it("should handle escaped quotes", () => {
    // In the template literal, \\" becomes a literal backslash + quote: "he\"llo" rest
    // The string is: " h e \ " l l o " (indices 0-8), returns 9
    const code = `"he\\"llo" rest`;
    expect(skipStringOrComment(code, 0)).toBe(9);
  });

  it("should skip template literals", () => {
    const code = "`template` rest";
    expect(skipStringOrComment(code, 0)).toBe(10);
  });

  it("should skip template literals with expressions", () => {
    const code = "`hello ${name}` rest";
    expect(skipStringOrComment(code, 0)).toBe(15);
  });

  it("should skip single-line comments", () => {
    const code = "// comment\nrest";
    expect(skipStringOrComment(code, 0)).toBe(11);
  });

  it("should skip multi-line comments", () => {
    const code = "/* comment */ rest";
    expect(skipStringOrComment(code, 0)).toBe(13);
  });

  it("should return pos for non-string/comment chars", () => {
    const code = "abc";
    expect(skipStringOrComment(code, 0)).toBe(0);
  });

  it("should handle unterminated double-quoted string", () => {
    const code = `"unterminated`;
    expect(skipStringOrComment(code, 0)).toBe(code.length);
  });

  it("should handle unterminated single-quoted string", () => {
    const code = `'unterminated`;
    expect(skipStringOrComment(code, 0)).toBe(code.length);
  });

  it("should handle unterminated template literal", () => {
    const code = "`unterminated";
    expect(skipStringOrComment(code, 0)).toBe(code.length);
  });

  it("should handle nested template expression with string", () => {
    const code = "`a ${`inner`} b` rest";
    expect(skipStringOrComment(code, 0)).toBe(16);
  });

  it("should handle unterminated block comment", () => {
    const code = "/* unclosed";
    expect(skipStringOrComment(code, 0)).toBe(code.length);
  });

  it("should not treat / alone as comment start", () => {
    const code = "a / b";
    // At pos 2, the char is '/', next is ' ' (not / or *), so returns pos
    expect(skipStringOrComment(code, 2)).toBe(2);
  });
});

describe("findMatchingParen", () => {
  it("should find simple closing paren", () => {
    const code = "fn(a, b)";
    // startPos is after the opening paren
    expect(findMatchingParen(code, 3)).toBe(8);
  });

  it("should handle nested parens", () => {
    const code = "fn(a(b), c)";
    expect(findMatchingParen(code, 3)).toBe(11);
  });

  it("should skip parens inside strings", () => {
    const code = `fn("(", b)`;
    expect(findMatchingParen(code, 3)).toBe(10);
  });

  it("should skip parens inside comments", () => {
    const code = "fn(/* ( */ b)";
    expect(findMatchingParen(code, 3)).toBe(13);
  });
});

describe("countArgs", () => {
  it("should count zero args for empty parens", () => {
    const code = "fn()";
    expect(countArgs(code, 3, 3)).toBe(0);
  });

  it("should count one arg", () => {
    const code = "fn(a)";
    expect(countArgs(code, 3, 4)).toBe(1);
  });

  it("should count two args", () => {
    const code = "fn(a, b)";
    expect(countArgs(code, 3, 7)).toBe(2);
  });

  it("should not count commas inside nested structures", () => {
    const code = "fn({a: 1, b: 2}, c)";
    expect(countArgs(code, 3, 18)).toBe(2);
  });

  it("should skip commas inside strings", () => {
    const code = `fn("a,b", c)`;
    expect(countArgs(code, 3, 11)).toBe(2);
  });

  it("should count whitespace-only as zero args", () => {
    const code = "fn(   )";
    expect(countArgs(code, 3, 6)).toBe(0);
  });

  it("should handle three args", () => {
    const code = "fn(a, b, c)";
    expect(countArgs(code, 3, 10)).toBe(3);
  });

  it("should handle nested array brackets", () => {
    const code = "fn([1, 2], b)";
    expect(countArgs(code, 3, 12)).toBe(2);
  });
});

describe("findStatementEnd", () => {
  it("should skip whitespace and semicolon", () => {
    // "foo() ;\nbar()" - pos 5 is space, 6 is ;, returns 7
    const code = "foo() ;\nbar()";
    expect(findStatementEnd(code, 5)).toBe(7);
  });

  it("should skip newline as whitespace before semicolon", () => {
    // "foo()\nbar()" - pos 5 is \n (whitespace), skips to pos 6 which is 'b' (not ;)
    const code = "foo()\nbar()";
    expect(findStatementEnd(code, 5)).toBe(6);
  });

  it("should skip trailing whitespace including newlines", () => {
    // "foo()  \n" - pos 5 is space, 6 is space, 7 is \n, skips to 8 (end), no semicolon
    const code = "foo()  \n";
    expect(findStatementEnd(code, 5)).toBe(8);
  });

  it("should return pos when immediately followed by non-whitespace", () => {
    const code = "foo()bar()";
    expect(findStatementEnd(code, 5)).toBe(5);
  });

  it("should consume semicolon immediately after position", () => {
    const code = "foo();bar()";
    expect(findStatementEnd(code, 5)).toBe(6);
  });
});
