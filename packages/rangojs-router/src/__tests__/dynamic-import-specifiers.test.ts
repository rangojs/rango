import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * @vitejs/plugin-rsc's client-reference scan build rewrites every module to
 * `import "<specifier>"` lines from es-module-lexer. es-module-lexer 3
 * (plugin-rsc 0.5.36) reports an `import()` of a template literal with a
 * substitution as the specifier "/*", so `import(`/${x}`)` anywhere in router
 * source fails every consumer build with `Could not resolve '/*'`. Import a
 * variable instead.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

// `as`, `<T>`, `!`, `satisfies` and parentheses are stripped before
// es-module-lexer sees the code.
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function templateImports(fileName: string, code: string): number[] {
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
  );
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isTemplateExpression(unwrap(node.arguments[0]))
    ) {
      lines.push(
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules"
        ? []
        : sourceFiles(path);
    }
    return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

describe("dynamic import specifiers in router source", () => {
  it("detects an import() of a template literal with a substitution", () => {
    expect(
      templateImports(
        "probe.ts",
        "const a = `/${x}`;\nawait import(/* @vite-ignore */ `/${x}`);\nawait import(a);\nawait import(`./static.js`);\nawait import(`/${x}` as string);\nawait import((`/${x}`)!);",
      ),
    ).toEqual([2, 5, 6]);
  });

  it("has no import() of a template literal with a substitution", () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      templateImports(file, readFileSync(file, "utf8")).map(
        (line) => `${relative(SRC, file)}:${line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
