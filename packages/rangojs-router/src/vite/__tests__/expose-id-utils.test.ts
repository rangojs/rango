import { describe, it, expect } from "vitest";
import {
  hashId,
  detectImports,
  makeExportPattern,
  skipStringOrComment,
  findMatchingParen,
  countArgs,
  findStatementEnd,
  findClosingParen,
  countArgsSimple,
} from "../expose-id-utils.ts";

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

  it("should detect createLocationState from @rangojs/router/client", () => {
    const code = `import { createLocationState } from "@rangojs/router/client";`;
    const result = detectImports(code);
    expect(result.locationState).toBe(true);
  });

  it("should detect createPrerenderHandler from @rangojs/router", () => {
    const code = `import { createPrerenderHandler } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.prerenderHandler).toBe(true);
  });

  it("should detect createStaticHandler from @rangojs/router", () => {
    const code = `import { createStaticHandler } from "@rangojs/router";`;
    const result = detectImports(code);
    expect(result.staticHandler).toBe(true);
    expect(result.any).toBe(true);
  });

  it("should detect createStaticHandler from @rangojs/router/server", () => {
    const code = `import { createStaticHandler } from "@rangojs/router/server";`;
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
});

describe("makeExportPattern", () => {
  it("should match export const X = createFoo(", () => {
    const pattern = makeExportPattern("createLoader");
    const code = `export const MyLoader = createLoader(`;
    expect(pattern.test(code)).toBe(true);
  });

  it("should capture the export name", () => {
    const pattern = makeExportPattern("createHandle");
    const code = `export const Breadcrumbs = createHandle<Item>(`;
    const match = pattern.exec(code);
    expect(match?.[1]).toBe("Breadcrumbs");
  });

  it("should handle generic type params", () => {
    const pattern = makeExportPattern("createLocationState");
    const code = `export const ProductState = createLocationState<Product>(`;
    expect(pattern.test(code)).toBe(true);
  });

  it("should NOT match non-exported declarations", () => {
    const pattern = makeExportPattern("createLoader");
    const code = `const MyLoader = createLoader(`;
    expect(pattern.test(code)).toBe(false);
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
    const code = '`hello ${name}` rest';
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

describe("findClosingParen", () => {
  it("should find simple closing paren", () => {
    const code = "fn(a, b)";
    expect(findClosingParen(code, 3)).toBe(8);
  });

  it("should handle nested parens", () => {
    const code = "fn(a(b), c)";
    expect(findClosingParen(code, 3)).toBe(11);
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
});

describe("countArgsSimple", () => {
  it("should count zero args for empty parens", () => {
    expect(countArgsSimple("fn()", 3, 3)).toBe(0);
  });

  it("should count two args", () => {
    expect(countArgsSimple("fn(a, b)", 3, 7)).toBe(2);
  });

  it("should not count commas inside nested structures", () => {
    expect(countArgsSimple("fn({a: 1, b: 2}, c)", 3, 18)).toBe(2);
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
