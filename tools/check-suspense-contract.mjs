#!/usr/bin/env node
// Suspense contract tripwire (docs/internal/suspense-contract.md).
//
// Two rules of the contract are about WHERE code may live, and that part can
// be checked without running anything:
//
//  1. Tree updates. Only a navigation, a back/forward, its stale
//     revalidation, an action, an error and HMR hand React a new tree. A file
//     outside EMITTERS that calls the store's update emitter is a new source
//     of tree updates: an inner update goes through a store its readers
//     subscribe to, or a pending promise read with use(). Every emit call in
//     the files that produce updates names its cause for the dev audit
//     (auditTreeCause) before it, and the subscriber counts what arrives
//     (auditTreeUpdate).
//
//  2. Boundary values. The router's Suspense boundaries, and the promises and
//     per-loader streams they are handed, are built in PRODUCERS. A file
//     outside it that creates a boundary element, calls the content or
//     aggregate helpers, or writes `loaderDataPromise` / `loaderStreams` is a
//     new producer. The dev-only Audited* boundary variants are referenced
//     only from AUDITED.
//
//  3. A build does not change. The audit modules import only what
//     DEV_ONLY_IMPORTS lists: a new static import there moves the imported
//     module earlier in the client router chunk (route-content-wrapper.tsx
//     imports both), and a build stops matching main byte for byte although
//     every audit call is folded away (measured in cloudflare-basic for
//     handles/is-thenable.ts and browser/react/context.ts).
//
// Read from the TypeScript AST, so comments never count, and a call through
// an import alias, a destructured or renamed binding, or a function that
// forwards its argument to the emitter is still a call of the emitter.
//
// This pins the place, not the behaviour: whether a producer hands a stable
// thenable is the dev audit's job (src/suspense-audit.ts) and the e2e suites'.
// A new entry here means: read the contract, add the case, then add the file
// with its reason.
//
// Run: node tools/check-suspense-contract.mjs

import ts from "typescript";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, walk } from "./lib/e2e-bucketing-scan.mjs";

const SRC = "packages/rangojs-router/src";

/** Files that may call the tree update emitter, and why. */
const EMITTERS = {
  "browser/navigation-store.ts": "defines onUpdate / emitUpdate",
  "browser/types.ts": "declares onUpdate / emitUpdate",
  "browser/react/NavigationProvider.tsx":
    "the one subscriber: hands the tree to React",
  "browser/partial-update.ts":
    "navigation, back/forward refetch, stale revalidation, action refetch",
  "browser/navigation-bridge.ts": "back/forward restore from the history cache",
  "browser/server-action-bridge.ts": "action result and action error boundary",
  "browser/network-error-handler.ts":
    "error: a failed request rendered into the tree",
  "browser/rsc-router.tsx": "wires the emitter into the bridges; HMR refetch",
  "testing/render-route.tsx": "test harness: navigate() and refresh()",
};

/** Emitters that produce updates must name the cause of each one. */
const MUST_NAME_A_CAUSE = [
  "browser/partial-update.ts",
  "browser/navigation-bridge.ts",
  "browser/server-action-bridge.ts",
  "browser/network-error-handler.ts",
  "browser/rsc-router.tsx",
  "testing/render-route.tsx",
];

/** Files that may build a router Suspense boundary or what it waits for. */
const PRODUCERS = {
  "segment-system.tsx": "renderSegments: every segment's boundaries",
  "client.tsx": "renderSlotContent: parallel and intercept slot boundaries",
  "route-content-wrapper.tsx": "the boundary components and their props",
  "segment-boundary-content.ts":
    "getBoundaryContent: what a route's content boundary is handed",
  "segment-loader-promise.ts": "getMemoizedLoaderPromise, buildLoaderPromise",
  "browser/merge-segment-loaders.ts":
    "client merge of a segment's loader results after a partial update",
  "client-urls/client-root.tsx":
    "clientUrls() group: optimistic loader streams",
  "router/intercept-resolution.ts":
    "server: an intercept slot's loader aggregate",
  "router/match-middleware/intercept-resolution.ts":
    "server: a fresh loader aggregate onto a cached intercept segment",
  "cache/segment-codec.ts": "decodes a cached segment's settled aggregate",
  "outlet-provider.tsx":
    "hands a boundary's per-loader streams to useLoader through the outlet context",
};

/** Files that may reference a dev-only Audited* boundary variant. */
const AUDITED = {
  "route-content-wrapper.tsx":
    "defines AuditedRouteContent, AuditedLoaderBoundary",
  "outlet-provider.tsx": "defines AuditedOutletProvider",
  "suspense-audit-react.tsx": "defines AuditedFallback, AuditedOutlet",
  "segment-system.tsx": "renderSegments picks the dev variants",
  "client.tsx": "renderSlotContent picks the dev variants",
};

/** The store's emitter and subscription, and the transition commit helper. */
const EMITTER_NAMES = new Set(["emitUpdate", "onUpdate", "commitInTransition"]);
const PRODUCER_CALLS = new Set([
  "getBoundaryContent",
  "getMemoizedLoaderPromise",
  "buildLoaderPromise",
  "buildLoaderStreams",
]);
const BOUNDARY_COMPONENTS = new Set(["RouteContentWrapper", "LoaderBoundary"]);
const BOUNDARY_FIELDS = new Set(["loaderDataPromise", "loaderStreams"]);
const AUDITED_NAME = /^Audited[A-Z]/;

/** The only imports of the dev-only audit modules (rule 3). */
const DEV_ONLY_IMPORTS = {
  "suspense-audit.ts": ["./internal-debug.js", "./internal-suspense-audit.js"],
  "suspense-audit-react.tsx": ["react", "./suspense-audit.js"],
};

const root = path.join(REPO_ROOT, SRC);
const files = walk(
  root,
  (p) =>
    /\.tsx?$/.test(p) &&
    !/\.(?:test|spec)\.tsx?$/.test(p) &&
    !p.split(path.sep).includes("__tests__"),
).map((file) => {
  const source = readFileSync(file, "utf8");
  return {
    rel: path.relative(root, file).split(path.sep).join("/"),
    sf: ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
});

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function propertyName(name) {
  return ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isPrivateIdentifier(name)
    ? name.text
    : undefined;
}

/**
 * Local names bound to one of `names` in a file: import aliases
 * (`import { x as y }`), destructured bindings (`const { x: y } = store`),
 * and plain aliases (`const y = store.x`, `const y = x`, `x.bind(...)`).
 */
function localAliases(sf, names) {
  const local = new Set(names);
  const refersTo = (expr) => {
    while (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "bind"
    ) {
      expr = expr.expression.expression;
    }
    if (ts.isIdentifier(expr)) return local.has(expr.text);
    if (ts.isPropertyAccessExpression(expr)) return names.has(expr.name.text);
    return false;
  };
  // Twice: an alias of an alias declared later in the file.
  for (let pass = 0; pass < 2; pass++) {
    visit(sf, (node) => {
      if (ts.isImportSpecifier(node)) {
        const imported = (node.propertyName ?? node.name).text;
        if (names.has(imported)) local.add(node.name.text);
      } else if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        ts.isObjectBindingPattern(node.parent)
      ) {
        const key = node.propertyName
          ? propertyName(node.propertyName)
          : node.name.text;
        if (key && names.has(key)) local.add(node.name.text);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        refersTo(node.initializer)
      ) {
        local.add(node.name.text);
      }
    });
  }
  return local;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function enclosingParams(node) {
  const params = new Set();
  for (let n = node.parent; n; n = n.parent) {
    if (isFunctionLike(n)) {
      for (const p of n.parameters) {
        if (ts.isIdentifier(p.name)) params.add(p.name.text);
      }
    }
  }
  return params;
}

// The name a function is reachable by: its declaration, the variable or the
// object property it is assigned to.
function functionName(fn) {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) {
    return fn.name ? propertyName(fn.name) : undefined;
  }
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) return propertyName(parent.name);
  return undefined;
}

function nearestFunction(node) {
  for (let n = node.parent; n; n = n.parent) if (isFunctionLike(n)) return n;
  return undefined;
}

/**
 * The emit calls of a file: a call of the emitter or of an alias of it. A
 * subscription (`store.onUpdate((update) => ...)`) counts as a reference, not
 * as an emit. `forwards` marks a call that only hands its function's own
 * parameters on: that function is itself an emitter, judged where it is
 * called.
 */
function emitCalls(sf, emitters, localEmitters = new Set()) {
  const local = localAliases(sf, new Set([...emitters, ...localEmitters]));
  const calls = [];
  const references = [];
  visit(sf, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      emitters.has(node.name.text) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      if (node.name.text === "emitUpdate") references.push(node);
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    let emitter;
    if (ts.isIdentifier(callee) && local.has(callee.text)) {
      emitter = callee.text;
    } else if (
      ts.isPropertyAccessExpression(callee) &&
      emitters.has(callee.name.text)
    ) {
      const [arg] = node.arguments;
      if (
        callee.name.text === "onUpdate" &&
        arg &&
        (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
      ) {
        references.push(node);
        return;
      }
      emitter = callee.name.text;
    }
    if (!emitter) return;
    const params = enclosingParams(node);
    const forwards =
      node.arguments.length > 0 &&
      node.arguments.every(
        (arg) =>
          (ts.isIdentifier(arg) && params.has(arg.text)) ||
          ts.isArrayLiteralExpression(arg),
      );
    calls.push({ node, emitter, forwards });
  });
  return { calls, references };
}

function isExported(sf, fn, name) {
  const exported = (node) =>
    ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export;
  if (ts.isFunctionDeclaration(fn) && exported(fn)) return true;
  if (ts.isVariableDeclaration(fn.parent) && exported(fn.parent)) {
    return true;
  }
  let found = false;
  visit(sf, (node) => {
    if (
      ts.isExportSpecifier(node) &&
      (node.propertyName ?? node.name).text === name
    ) {
      found = true;
    }
  });
  return found;
}

// The named function a forwarding call belongs to, past wrapper arrows
// (startTransition(() => onUpdate(update))).
function forwardingFunction(node) {
  for (let fn = nearestFunction(node); fn; fn = nearestFunction(fn)) {
    if (functionName(fn)) return fn;
  }
  return undefined;
}

// A function that forwards its arguments to the emitter is an emitter too:
// in its own file by its name, and in every file that imports it if it is
// exported. Until nothing new is found.
const emitters = new Set(EMITTER_NAMES);
const localEmitters = new Map(files.map(({ rel }) => [rel, new Set()]));
for (let grew = true; grew; ) {
  grew = false;
  for (const { rel, sf } of files) {
    const local = localEmitters.get(rel);
    for (let fileGrew = true; fileGrew; ) {
      fileGrew = false;
      for (const call of emitCalls(sf, emitters, local).calls) {
        if (!call.forwards) continue;
        const fn = forwardingFunction(call.node);
        const name = fn && functionName(fn);
        if (!name || local.has(name) || emitters.has(name)) continue;
        local.add(name);
        fileGrew = true;
        if (isExported(sf, fn, name)) {
          emitters.add(name);
          grew = true;
        }
      }
    }
  }
}

// A call of one of `names` that runs when `node` does: not inside a function
// it declares or creates.
function callsNamed(node, names) {
  let found = false;
  const search = (n) => {
    if (found || isFunctionLike(n) || ts.isClassDeclaration(n)) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      names.has(n.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, search);
  };
  search(node);
  return found;
}

/** An auditTreeCause call in a statement before the one holding `node`, at any enclosing level. */
function causedBefore(node, causeNames) {
  for (let child = node, n = node.parent; n; child = n, n = n.parent) {
    const statements =
      ts.isBlock(n) ||
      ts.isSourceFile(n) ||
      ts.isCaseClause(n) ||
      ts.isDefaultClause(n) ||
      ts.isModuleBlock(n)
        ? n.statements
        : undefined;
    if (!statements) continue;
    const at = statements.indexOf(child);
    for (let i = 0; i < at; i++) {
      if (callsNamed(statements[i], causeNames)) return true;
    }
  }
  return false;
}

function producerUse(sf) {
  const producers = localAliases(sf, PRODUCER_CALLS);
  const boundaries = localAliases(sf, BOUNDARY_COMPONENTS);
  let found;
  visit(sf, (node) => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      producers.has(node.expression.text)
    ) {
      found = { node, what: `calls ${node.expression.text}` };
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      PRODUCER_CALLS.has(node.name.text)
    ) {
      found = { node, what: `defines ${node.name.text}` };
    } else if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      boundaries.has(node.tagName.text)
    ) {
      found = { node, what: `creates <${node.tagName.text}>` };
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createElement" &&
      node.arguments[0] &&
      ts.isIdentifier(node.arguments[0]) &&
      boundaries.has(node.arguments[0].text)
    ) {
      found = { node, what: `creates ${node.arguments[0].text}` };
    } else if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node)) &&
      BOUNDARY_FIELDS.has(propertyName(node.name)) &&
      !ts.isObjectBindingPattern(node.parent)
    ) {
      found = { node, what: `writes ${propertyName(node.name)}` };
    } else if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      BOUNDARY_FIELDS.has(node.name.text)
    ) {
      found = { node, what: `passes ${node.name.text}` };
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = node.left;
      const field = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isElementAccessExpression(target) &&
            ts.isStringLiteral(target.argumentExpression)
          ? target.argumentExpression.text
          : undefined;
      if (field && BOUNDARY_FIELDS.has(field)) {
        found = { node, what: `writes ${field}` };
      }
    }
  });
  return found;
}

function auditedReference(sf) {
  let found;
  visit(sf, (node) => {
    if (!found && ts.isIdentifier(node) && AUDITED_NAME.test(node.text)) {
      found = node;
    }
  });
  return found;
}

const problems = [];
const seenEmitters = new Set();
const seenProducers = new Set();
const seenAudited = new Set();

for (const { rel, sf } of files) {
  const allowedImports = DEV_ONLY_IMPORTS[rel];
  if (allowedImports) {
    for (const statement of sf.statements) {
      if (
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        !allowedImports.includes(statement.moduleSpecifier.text)
      ) {
        problems.push(
          `${SRC}/${rel}:${lineOf(sf, statement)} imports ${statement.moduleSpecifier.text}. The audit modules import only ${allowedImports.join(", ")}: a new import reorders the client router chunk and a build stops matching main. Inline what you need.`,
        );
      }
    }
  }
  const { calls, references } = emitCalls(sf, emitters, localEmitters.get(rel));
  const definesEmitter = (() => {
    let found = false;
    visit(sf, (node) => {
      if (
        (ts.isMethodDeclaration(node) ||
          ts.isMethodSignature(node) ||
          ts.isPropertySignature(node)) &&
        node.name &&
        (propertyName(node.name) === "emitUpdate" ||
          propertyName(node.name) === "onUpdate")
      ) {
        found = true;
      }
    });
    return found;
  })();
  const first = calls[0]?.node ?? references[0];
  if (first || definesEmitter) seenEmitters.add(rel);
  if (first && !(rel in EMITTERS)) {
    problems.push(
      `${SRC}/${rel}:${lineOf(sf, first)} calls the tree update emitter. Only a navigation, an action, a back/forward, an error and HMR hand React a tree: update in place through a store or a promise read with use(), or add the file to EMITTERS with its cause.`,
    );
  }
  if (MUST_NAME_A_CAUSE.includes(rel)) {
    const causes = localAliases(sf, new Set(["auditTreeCause"]));
    for (const call of calls) {
      if (call.forwards || causedBefore(call.node, causes)) continue;
      problems.push(
        `${SRC}/${rel}:${lineOf(sf, call.node)} emits a tree update (${call.emitter}) without naming its cause first (auditTreeCause).`,
      );
    }
  }
  if (rel === "browser/react/NavigationProvider.tsx") {
    const counters = localAliases(sf, new Set(["auditTreeUpdate"]));
    let counted = false;
    visit(sf, (node) => {
      counted ||=
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        counters.has(node.expression.text);
    });
    if (!counted) {
      problems.push(
        `${SRC}/${rel} no longer counts the tree updates it receives (auditTreeUpdate).`,
      );
    }
  }
  const produced = producerUse(sf);
  if (produced) {
    seenProducers.add(rel);
    if (!(rel in PRODUCERS)) {
      problems.push(
        `${SRC}/${rel}:${lineOf(sf, produced.node)} builds a router Suspense boundary or a value one waits for (${produced.what}). Read docs/internal/suspense-contract.md, cover the new producer with a case, then add the file to PRODUCERS.`,
      );
    }
  }
  const audited = auditedReference(sf);
  if (audited) {
    seenAudited.add(rel);
    if (!(rel in AUDITED)) {
      problems.push(
        `${SRC}/${rel}:${lineOf(sf, audited)} references ${audited.text}, a dev-only boundary variant. segment-system.tsx and client.tsx pick them behind the NODE_ENV and INTERNAL_RANGO_SUSPENSE_AUDIT test; add the file to AUDITED with its reason only if it does the same.`,
      );
    }
  }
}

for (const [list, seen, what] of [
  [EMITTERS, seenEmitters, "no longer calls the emitter"],
  [PRODUCERS, seenProducers, "no longer builds a boundary value"],
  [AUDITED, seenAudited, "no longer references an Audited* variant"],
]) {
  for (const rel of Object.keys(list)) {
    if (!seen.has(rel)) {
      problems.push(`${SRC}/${rel} is listed but ${what}: remove it.`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Suspense contract check: ${problems.length} problem(s).\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `Suspense contract check: OK — ${seenEmitters.size} file(s) call the tree update emitter, ${seenProducers.size} build boundary values, ${seenAudited.size} reference the dev variants, all listed.`,
);
