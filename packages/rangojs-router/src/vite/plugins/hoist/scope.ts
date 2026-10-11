/**
 * Scope analysis shared by the build-time predicate hoists
 * (transition-when-hoist.ts, client-urls-revalidate-hoist.ts): a module's
 * scope tree, every identifier reference, and its imports. Enough of ES
 * scoping for the free-variable analysis of one literal.
 */

// oxc ESTree nodes; the hoists read a handful of fields off each.
export type Node = any;

export interface ImportBinding {
  readonly source: string;
  /** "default", "*", or the imported name. */
  readonly imported: string;
  readonly typeOnly: boolean;
}

export class Scope {
  readonly declarations: Set<string> = new Set<string>();
  constructor(
    readonly parent: Scope | null,
    readonly isFunction: boolean,
    readonly node: Node,
  ) {}
  nearestFunction(): Scope {
    return this.isFunction || !this.parent
      ? this
      : this.parent.nearestFunction();
  }
  lookup(name: string): Scope | null {
    if (this.declarations.has(name)) return this;
    return this.parent ? this.parent.lookup(name) : null;
  }
}

export interface Reference {
  readonly node: Node;
  readonly scope: Scope;
  readonly typeOnly: boolean;
}

export const TYPE_KEYS: ReadonlySet<string> = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "implements",
]);
/**
 * The identifier a JSX element name refers to: a component (`<Local />`) or
 * the root of a member name (`<ui.Badge />`). Lowercase and dashed names are
 * intrinsic tags, not references; `<this.X />` is checked as `this`.
 */
function jsxNameReference(name: Node): Node | null {
  if (name?.type === "JSXIdentifier") {
    return /^[a-z]/.test(name.name) || name.name.includes("-") ? null : name;
  }
  let root = name;
  while (root?.type === "JSXMemberExpression") root = root.object;
  return root?.type === "JSXIdentifier" && root.name !== "this" ? root : null;
}

function patternNames(pattern: Node, names: string[] = []): string[] {
  if (!pattern) return names;
  switch (pattern.type) {
    case "Identifier":
      names.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        patternNames(prop.type === "RestElement" ? prop : prop.value, names);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) patternNames(element, names);
      break;
    case "RestElement":
      patternNames(pattern.argument, names);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, names);
      break;
    case "TSParameterProperty":
      patternNames(pattern.parameter, names);
      break;
  }
  return names;
}

/**
 * Scope tree and every identifier reference of a module, TS type positions
 * flagged. Enough of ES scoping for free-variable analysis of one literal:
 * var hoists to the function scope, let/const/class to the block, function
 * declarations to their block.
 */
export function analyzeScopes(program: Node): {
  moduleScope: Scope;
  references: Reference[];
  scopeOf: Map<Node, Scope>;
} {
  const moduleScope = new Scope(null, true, program);
  const scopeOf = new Map<Node, Scope>([[program, moduleScope]]);
  const references: Reference[] = [];

  const declarePattern = (pattern: Node, scope: Scope): void => {
    for (const name of patternNames(pattern)) scope.declarations.add(name);
  };

  // Binding patterns: identifiers declare; defaults and computed keys refer.
  const walkPattern = (pattern: Node, scope: Scope, typeOnly: boolean) => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        if (pattern.typeAnnotation) walk(pattern.typeAnnotation, scope, true);
        return;
      case "ObjectPattern":
        for (const prop of pattern.properties) {
          if (prop.type === "RestElement") {
            walkPattern(prop.argument, scope, typeOnly);
          } else {
            if (prop.computed) walk(prop.key, scope, typeOnly);
            walkPattern(prop.value, scope, typeOnly);
          }
        }
        if (pattern.typeAnnotation) walk(pattern.typeAnnotation, scope, true);
        return;
      case "ArrayPattern":
        for (const element of pattern.elements) {
          walkPattern(element, scope, typeOnly);
        }
        if (pattern.typeAnnotation) walk(pattern.typeAnnotation, scope, true);
        return;
      case "RestElement":
        walkPattern(pattern.argument, scope, typeOnly);
        return;
      case "AssignmentPattern":
        walkPattern(pattern.left, scope, typeOnly);
        walk(pattern.right, scope, typeOnly);
        return;
      case "TSParameterProperty":
        walkPattern(pattern.parameter, scope, typeOnly);
        return;
      default:
        walk(pattern, scope, typeOnly);
    }
  };

  // Hoist function-scoped and block-scoped declarations of a body before its
  // statements are walked, so a reference ahead of its declaration resolves.
  const hoistDeclarations = (statements: Node[], scope: Scope): void => {
    for (const statement of statements) {
      const node =
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration"
          ? statement.declaration
          : statement;
      if (!node) continue;
      switch (node.type) {
        case "ImportDeclaration":
          for (const spec of node.specifiers) {
            scope.declarations.add(spec.local.name);
          }
          break;
        case "FunctionDeclaration":
        case "ClassDeclaration":
        case "TSEnumDeclaration":
        case "TSTypeAliasDeclaration":
        case "TSInterfaceDeclaration":
        case "TSModuleDeclaration":
          if (node.id?.type === "Identifier") {
            scope.declarations.add(node.id.name);
          }
          break;
        case "VariableDeclaration":
          for (const declarator of node.declarations) {
            declarePattern(
              declarator.id,
              node.kind === "var" ? scope.nearestFunction() : scope,
            );
          }
          break;
      }
    }
  };

  const walk = (node: Node, scope: Scope, typeOnly: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, scope, typeOnly);
      return;
    }
    if (typeof node.type !== "string") return;

    switch (node.type) {
      case "Identifier":
        references.push({ node, scope, typeOnly });
        if (node.typeAnnotation) walk(node.typeAnnotation, scope, true);
        return;
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        return;
      case "ExportNamedDeclaration":
        if (node.declaration) walk(node.declaration, scope, typeOnly);
        else if (!node.source) {
          for (const spec of node.specifiers) {
            walk(spec.local, scope, typeOnly || node.exportKind === "type");
          }
        }
        return;
      case "MemberExpression":
        walk(node.object, scope, typeOnly);
        if (node.computed) walk(node.property, scope, typeOnly);
        return;
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition":
      case "TSPropertySignature":
      case "TSMethodSignature":
        if (node.computed) walk(node.key, scope, typeOnly);
        walk(node.value, scope, typeOnly);
        if (node.typeAnnotation) walk(node.typeAnnotation, scope, true);
        return;
      case "LabeledStatement":
        walk(node.body, scope, typeOnly);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
        return;
      case "JSXOpeningElement":
      case "JSXClosingElement": {
        const ref = jsxNameReference(node.name);
        if (ref) references.push({ node: ref, scope, typeOnly });
        walk(node.typeArguments, scope, true);
        walk(node.attributes, scope, typeOnly);
        return;
      }
      case "TSQualifiedName":
        walk(node.left, scope, typeOnly);
        return;
      case "TSEnumMember":
        walk(node.initializer, scope, typeOnly);
        return;
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
        walk(node.typeParameters, scope, true);
        walk(node.typeAnnotation ?? node.body, scope, true);
        walk(node.extends, scope, true);
        return;
      case "VariableDeclarator":
        walkPattern(node.id, scope, typeOnly);
        walk(node.init, scope, typeOnly);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const fnScope = new Scope(scope, true, node);
        scopeOf.set(node, fnScope);
        if (node.type === "FunctionExpression" && node.id) {
          fnScope.declarations.add(node.id.name);
        }
        for (const param of node.params) declarePattern(param, fnScope);
        walk(node.typeParameters, fnScope, true);
        for (const param of node.params) walkPattern(param, fnScope, typeOnly);
        walk(node.returnType, fnScope, true);
        if (node.body?.type === "BlockStatement") {
          hoistDeclarations(node.body.body, fnScope);
          walk(node.body.body, fnScope, typeOnly);
        } else {
          walk(node.body, fnScope, typeOnly);
        }
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        let classScope = scope;
        if (node.type === "ClassExpression" && node.id) {
          classScope = new Scope(scope, false, node);
          classScope.declarations.add(node.id.name);
          scopeOf.set(node, classScope);
        }
        walk(node.superClass, classScope, typeOnly);
        walk(node.superTypeArguments, classScope, true);
        walk(node.typeParameters, classScope, true);
        walk(node.implements, classScope, true);
        walk(node.body, classScope, typeOnly);
        return;
      }
      case "BlockStatement":
      case "StaticBlock": {
        const blockScope = new Scope(scope, false, node);
        scopeOf.set(node, blockScope);
        hoistDeclarations(node.body, blockScope);
        walk(node.body, blockScope, typeOnly);
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const loopScope = new Scope(scope, false, node);
        scopeOf.set(node, loopScope);
        const head = node.type === "ForStatement" ? node.init : node.left;
        if (head?.type === "VariableDeclaration") {
          hoistDeclarations([head], loopScope);
        }
        for (const key of ["init", "left", "right", "test", "update", "body"]) {
          walk(node[key], loopScope, typeOnly);
        }
        return;
      }
      case "SwitchStatement": {
        walk(node.discriminant, scope, typeOnly);
        const switchScope = new Scope(scope, false, node);
        scopeOf.set(node, switchScope);
        hoistDeclarations(
          node.cases.flatMap((c: Node) => c.consequent),
          switchScope,
        );
        for (const c of node.cases) {
          walk(c.test, switchScope, typeOnly);
          walk(c.consequent, switchScope, typeOnly);
        }
        return;
      }
      case "CatchClause": {
        const catchScope = new Scope(scope, false, node);
        scopeOf.set(node, catchScope);
        if (node.param) {
          declarePattern(node.param, catchScope);
          walkPattern(node.param, catchScope, typeOnly);
        }
        walk(node.body, catchScope, typeOnly);
        return;
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      walk(node[key], scope, typeOnly || TYPE_KEYS.has(key));
    }
  };

  hoistDeclarations(program.body, moduleScope);
  walk(program.body, moduleScope, false);
  return { moduleScope, references, scopeOf };
}

export function collectImports(program: Node): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const declTypeOnly = statement.importKind === "type";
    for (const spec of statement.specifiers) {
      imports.set(spec.local.name, {
        source: statement.source.value,
        imported:
          spec.type === "ImportDefaultSpecifier"
            ? "default"
            : spec.type === "ImportNamespaceSpecifier"
              ? "*"
              : spec.imported.type === "Identifier"
                ? spec.imported.name
                : String(spec.imported.value),
        typeOnly: declTypeOnly || spec.importKind === "type",
      });
    }
  }
  return imports;
}
