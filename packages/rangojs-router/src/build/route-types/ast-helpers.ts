import ts from "typescript";

export function getStringValue(node: ts.Node): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

export function extractObjectStringProperties(
  node: ts.ObjectLiteralExpression,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    if (!key) continue;
    const val = getStringValue(prop.initializer);
    if (val !== null) result[key] = val;
  }
  return result;
}
