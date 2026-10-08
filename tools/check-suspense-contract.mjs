#!/usr/bin/env node
// Suspense contract tripwire (docs/internal/suspense-contract.md).
//
// Three rules of the contract are about WHERE code may live, and that part
// can be checked without running anything:
//
//  1. Tree updates. Only a navigation, a back/forward, its stale
//     revalidation, an action, an error and HMR hand React a new tree. A file
//     outside EMITTERS that calls the store's update emitter is a new source
//     of tree updates: an inner update goes through a store its readers
//     subscribe to, or a pending promise read with use(). Every emit call in
//     the files that produce updates names its cause for the dev audit
//     (auditTreeCause) in the same synchronous stretch, with no await between
//     the two: the cause does not outlive its task. The subscriber counts
//     what arrives (auditTreeUpdate).
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
// Calls are resolved with the TypeScript checker, so an import or namespace
// alias, a destructured or renamed binding, an element access
// (`store["emitUpdate"](u)`) and a function that forwards its parameters to
// the emitter all count, and an unrelated `onUpdate` prop does not: an emit
// is a call of the store's emitUpdate, of an UpdateSubscriber, or of a
// forwarder of one. Not seen: Reflect.apply, Function.prototype.call/apply
// and bind on a value the checker cannot follow, and a cause named in another
// function than the emit's; a cause before a callback is accepted only for
// startTransition's, which React runs synchronously.
//
// This pins the place, not the behaviour: whether a producer hands a stable
// thenable is the dev audit's job (src/suspense-audit.ts) and the e2e suites'.
// A new entry here means: read the contract, add the case, then add the file
// with its reason.
//
// Run: node tools/check-suspense-contract.mjs

import ts from "typescript";
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
const scanned = walk(
  root,
  (p) =>
    /\.tsx?$/.test(p) &&
    !/\.(?:test|spec)\.tsx?$/.test(p) &&
    !p.split(path.sep).includes("__tests__"),
);
const config = ts.getParsedCommandLineOfConfigFile(
  path.join(REPO_ROOT, "packages/rangojs-router/tsconfig.json"),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText));
    },
  },
);
const program = ts.createProgram({
  rootNames: scanned,
  options: { ...config.options, noEmit: true },
});
const checker = program.getTypeChecker();
const files = scanned.map((file) => ({
  rel: path.relative(root, file).split(path.sep).join("/"),
  sf: program.getSourceFile(file),
}));

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function propertyName(name) {
  if (!name) return undefined;
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    return ts.isStringLiteralLike(expr) ? expr.text : undefined;
  }
  return ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isPrivateIdentifier(name)
    ? name.text
    : undefined;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function inRouter(node) {
  return node.getSourceFile().fileName.startsWith(root + path.sep);
}

// The declaration a call resolves to, once per call.
const resolved = new Map();
function calleeDeclaration(call) {
  if (!resolved.has(call)) {
    let declaration;
    try {
      declaration = checker.getResolvedSignature(call)?.declaration;
    } catch {
      declaration = undefined;
    }
    resolved.set(call, declaration);
  }
  return resolved.get(call);
}

// The symbol an expression names, through import and namespace aliases.
function targetSymbol(expr) {
  let symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(expr) ? expr.name : expr,
  );
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function isUpdateSubscriber(declaration) {
  return (
    ts.isFunctionTypeNode(declaration) &&
    ts.isTypeAliasDeclaration(declaration.parent) &&
    declaration.parent.name.text === "UpdateSubscriber" &&
    inRouter(declaration)
  );
}

function isStoreMember(declaration, name) {
  return (
    (ts.isMethodSignature(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
    propertyName(declaration.name) === name &&
    inRouter(declaration)
  );
}

function isRouterFunction(declaration, names) {
  return (
    ts.isFunctionDeclaration(declaration) &&
    declaration.name !== undefined &&
    names.has(declaration.name.text) &&
    inRouter(declaration)
  );
}

// Functions that hand their own parameters to the emitter: emitters too,
// judged where they are called (commitInTransition, an adapter arrow).
const forwarders = new Set();

/**
 * An emit (the store's emitUpdate, an UpdateSubscriber, a forwarder) or the
 * subscription (the store's onUpdate), or undefined.
 */
function classify(call) {
  const declaration = calleeDeclaration(call);
  if (!declaration) return undefined;
  if (forwarders.has(declaration)) return "emit";
  if (isUpdateSubscriber(declaration)) return "emit";
  if (isStoreMember(declaration, "emitUpdate")) return "emit";
  if (isStoreMember(declaration, "onUpdate")) return "subscribe";
  return undefined;
}

/** The function whose parameters a call hands on unchanged, if every argument is one. */
function forwardedFrom(call) {
  if (call.arguments.length === 0) return undefined;
  let from;
  for (const arg of call.arguments) {
    if (ts.isArrayLiteralExpression(arg)) continue;
    if (!ts.isIdentifier(arg)) return undefined;
    const declaration = checker.getSymbolAtLocation(arg)?.valueDeclaration;
    if (!declaration || !ts.isParameter(declaration)) return undefined;
    if (from && from !== declaration.parent) return undefined;
    from = declaration.parent;
  }
  return from;
}

const calls = new Map(
  files.map(({ rel, sf }) => {
    const list = [];
    visit(sf, (node) => {
      if (ts.isCallExpression(node)) list.push(node);
    });
    return [rel, list];
  }),
);

for (let grew = true; grew; ) {
  grew = false;
  for (const list of calls.values()) {
    for (const call of list) {
      if (classify(call) !== "emit") continue;
      const from = forwardedFrom(call);
      if (from && !forwarders.has(from)) {
        forwarders.add(from);
        grew = true;
      }
    }
  }
}

function emitterUse(rel, sf) {
  const emits = [];
  const references = [];
  for (const call of calls.get(rel)) {
    const kind = classify(call);
    if (kind === "emit") {
      emits.push({ node: call, forwards: forwardedFrom(call) !== undefined });
    } else if (kind === "subscribe") {
      references.push(call);
    }
  }
  // The emitter handed on as a value: `register(store.emitUpdate)`.
  visit(sf, (node) => {
    const access =
      ts.isPropertyAccessExpression(node) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression));
    if (!access) return;
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      return;
    }
    const declaration = targetSymbol(
      ts.isPropertyAccessExpression(node) ? node : node.argumentExpression,
    )?.declarations?.[0];
    const named = ts.isElementAccessExpression(node)
      ? node.argumentExpression.text === "emitUpdate"
      : declaration && isStoreMember(declaration, "emitUpdate");
    if (named) references.push(node);
  });
  return { emits, references };
}

function isCause(call) {
  const declaration = calleeDeclaration(call);
  return (
    declaration !== undefined &&
    isRouterFunction(declaration, new Set(["auditTreeCause"]))
  );
}

// The last cause called when `node` runs, outside the functions it creates.
function lastCause(node) {
  let last;
  const search = (n) => {
    if (isFunctionLike(n) || ts.isClassDeclaration(n)) return;
    if (ts.isCallExpression(n) && isCause(n)) last = n;
    ts.forEachChild(n, search);
  };
  search(node);
  return last;
}

// React runs a startTransition callback synchronously, so a cause named
// before the call still covers an emit inside it.
function isStartTransitionCallback(fn) {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== fn) return false;
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return name === "startTransition";
}

function statementList(node) {
  return ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node) ||
    ts.isModuleBlock(node)
    ? node.statements
    : undefined;
}

// An await (or yield) that runs when `node` does, at or after `after`.
function suspends(node, after = -1) {
  let found = false;
  const search = (n) => {
    if (found || isFunctionLike(n)) return;
    if (
      n.pos >= after &&
      (ts.isAwaitExpression(n) ||
        ts.isYieldExpression(n) ||
        (ts.isForOfStatement(n) && n.awaitModifier))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, search);
  };
  search(node);
  return found;
}

/**
 * An await on the path from the cause (statement `from` of `block`) to the
 * call: later in the cause's statement, in the statements between, and in
 * whatever runs before the call inside the statement holding it. A branch
 * the call is not in (the other arm of an if) is not on the path.
 */
function suspendsBetween(cause, block, from, to, call) {
  const statements = statementList(block);
  if (suspends(statements[from], cause.end)) return true;
  for (let i = from + 1; i < to; i++) {
    if (suspends(statements[i])) return true;
  }
  for (
    let child = call, n = call.parent;
    n !== block;
    child = n, n = n.parent
  ) {
    const list = statementList(n);
    if (list) {
      for (const statement of list) {
        if (statement === child) break;
        if (suspends(statement)) return true;
      }
    } else if (ts.isIfStatement(n)) {
      if (child !== n.expression && suspends(n.expression)) return true;
    } else if (ts.isConditionalExpression(n)) {
      if (child !== n.condition && suspends(n.condition)) return true;
    } else {
      let hit = false;
      ts.forEachChild(n, (c) => {
        hit ||= c.end <= child.pos && suspends(c);
      });
      if (hit) return true;
    }
  }
  return false;
}

/**
 * The nearest cause named before `call` in the same synchronous stretch: in
 * a statement before the one holding the call, at any enclosing level up to
 * the function, past startTransition's callback, with no await (or yield) on
 * the path between the cause and the call.
 */
function causedBefore(call) {
  for (let child = call, n = call.parent; n; child = n, n = n.parent) {
    const statements = statementList(n);
    if (statements) {
      const at = statements.indexOf(child);
      for (let i = at - 1; i >= 0; i--) {
        const cause = lastCause(statements[i]);
        if (!cause) continue;
        return !suspendsBetween(cause, n, i, at, call);
      }
    }
    if (isFunctionLike(n) && !isStartTransitionCallback(n)) return false;
  }
  return false;
}

function boundaryName(expr) {
  const symbol = targetSymbol(expr);
  const name = symbol?.name;
  return name && BOUNDARY_COMPONENTS.has(name) ? name : undefined;
}

function producerUse(rel, sf) {
  for (const call of calls.get(rel)) {
    const declaration = calleeDeclaration(call);
    if (declaration && isRouterFunction(declaration, PRODUCER_CALLS)) {
      return { node: call, what: `calls ${declaration.name.text}` };
    }
    const callee = call.expression;
    const isCreateElement =
      (ts.isIdentifier(callee) && callee.text === "createElement") ||
      (ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "createElement");
    const created = isCreateElement && call.arguments[0];
    const name = created && boundaryName(created);
    if (name) return { node: call, what: `creates ${name}` };
  }
  let found;
  visit(sf, (node) => {
    if (found) return;
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      PRODUCER_CALLS.has(node.name.text)
    ) {
      found = { node, what: `defines ${node.name.text}` };
    } else if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      boundaryName(node.tagName)
    ) {
      found = { node, what: `creates <${node.tagName.getText(sf)}>` };
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
            ts.isStringLiteralLike(target.argumentExpression)
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

// The store's emitUpdate / onUpdate, or a config field typed UpdateSubscriber.
function definesEmitter(sf) {
  let found = false;
  visit(sf, (node) => {
    found ||=
      ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) &&
        ["emitUpdate", "onUpdate"].includes(propertyName(node.name))) ||
      (ts.isPropertySignature(node) &&
        node.type !== undefined &&
        ts.isTypeReferenceNode(node.type) &&
        node.type.typeName.getText(sf) === "UpdateSubscriber");
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
  const { emits, references } = emitterUse(rel, sf);
  const first = emits[0]?.node ?? references[0];
  if (first || definesEmitter(sf)) seenEmitters.add(rel);
  if (first && !(rel in EMITTERS)) {
    problems.push(
      `${SRC}/${rel}:${lineOf(sf, first)} calls the tree update emitter. Only a navigation, an action, a back/forward, an error and HMR hand React a tree: update in place through a store or a promise read with use(), or add the file to EMITTERS with its cause.`,
    );
  }
  if (MUST_NAME_A_CAUSE.includes(rel)) {
    for (const emit of emits) {
      if (emit.forwards || causedBefore(emit.node)) continue;
      problems.push(
        `${SRC}/${rel}:${lineOf(sf, emit.node)} emits a tree update (${emit.node.expression.getText(sf)}) without naming its cause first in the same synchronous stretch (auditTreeCause, no await between).`,
      );
    }
  }
  if (rel === "browser/react/NavigationProvider.tsx") {
    const counted = calls.get(rel).some((call) => {
      const declaration = calleeDeclaration(call);
      return (
        declaration !== undefined &&
        isRouterFunction(declaration, new Set(["auditTreeUpdate"]))
      );
    });
    if (!counted) {
      problems.push(
        `${SRC}/${rel} no longer counts the tree updates it receives (auditTreeUpdate).`,
      );
    }
  }
  const produced = producerUse(rel, sf);
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
