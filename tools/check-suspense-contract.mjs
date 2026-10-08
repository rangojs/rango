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
//     subscribe to, or a pending promise read with use(). Every emitter also
//     names its cause for the dev audit (auditTreeCause), and the subscriber
//     counts what arrives (auditTreeUpdate).
//
//  2. Boundary values. The router's Suspense boundaries, and the promises and
//     per-loader streams they are handed, are built in PRODUCERS. A file
//     outside it that creates a boundary element, calls the content or
//     aggregate helpers, or writes `loaderDataPromise` / `loaderStreams` is a
//     new producer.
//
// This pins the place, not the behaviour: whether a producer hands a stable
// thenable is the dev audit's job (src/suspense-audit.ts) and the e2e suites'.
// A new entry here means: read the contract, add the case, then add the file
// with its reason.
//
// Run: node tools/check-suspense-contract.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
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
  "segment-content-promise.ts": "getMemoizedContentPromise",
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
};

const EMITTER_CALL = /\b(?:emitUpdate|onUpdate|commitInTransition)\s*\(/;
const PRODUCER_USE = [
  /\bgetMemoizedContentPromise\s*\(/,
  /\bgetMemoizedLoaderPromise\s*\(/,
  /\bbuildLoaderPromise\s*\(/,
  /\bbuildLoaderStreams\s*\(/,
  /<(?:RouteContentWrapper|LoaderBoundary)\b/,
  /\bcreateElement\(\s*(?:RouteContentWrapper|LoaderBoundary)\b/,
  // A write, not a type: `loaderDataPromise: Promise<...>` declares one.
  /\bloaderDataPromise\s*[:=](?!=)(?!\s*Promise<)/,
  /\bloaderStreams\s*[:=](?!=)(?!\s*Record<)/,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// Comments describe the emitter and the boundaries by name all over src.
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function firstLine(source, pattern) {
  const match = pattern.exec(source);
  return match ? source.slice(0, match.index).split("\n").length : 0;
}

const root = path.join(REPO_ROOT, SRC);
const problems = [];
const seenEmitters = new Set();
const seenProducers = new Set();

for (const file of walk(root)) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const source = code(readFileSync(file, "utf8"));

  if (EMITTER_CALL.test(source)) {
    seenEmitters.add(rel);
    if (!(rel in EMITTERS)) {
      problems.push(
        `${SRC}/${rel}:${firstLine(source, EMITTER_CALL)} calls the tree update emitter. Only a navigation, an action, a back/forward, an error and HMR hand React a tree: update in place through a store or a promise read with use(), or add the file to EMITTERS with its cause.`,
      );
    }
  }
  const produced = PRODUCER_USE.find((pattern) => pattern.test(source));
  if (produced) {
    seenProducers.add(rel);
    if (!(rel in PRODUCERS)) {
      problems.push(
        `${SRC}/${rel}:${firstLine(source, produced)} builds a router Suspense boundary or a value one waits for (${produced.source}). Read docs/internal/suspense-contract.md, cover the new producer with a case, then add the file to PRODUCERS.`,
      );
    }
  }
  if (
    MUST_NAME_A_CAUSE.includes(rel) &&
    !/\bauditTreeCause\s*\(/.test(source)
  ) {
    problems.push(
      `${SRC}/${rel} emits tree updates and no longer names their cause (auditTreeCause).`,
    );
  }
  if (
    rel === "browser/react/NavigationProvider.tsx" &&
    !/\bauditTreeUpdate\s*\(/.test(source)
  ) {
    problems.push(
      `${SRC}/${rel} no longer counts the tree updates it receives (auditTreeUpdate).`,
    );
  }
}

for (const rel of Object.keys(EMITTERS)) {
  if (!seenEmitters.has(rel)) {
    problems.push(
      `EMITTERS lists ${SRC}/${rel}, which no longer calls the emitter: remove it.`,
    );
  }
}
for (const rel of Object.keys(PRODUCERS)) {
  if (!seenProducers.has(rel)) {
    problems.push(
      `PRODUCERS lists ${SRC}/${rel}, which no longer builds a boundary value: remove it.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`Suspense contract check: ${problems.length} problem(s).\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `Suspense contract check: OK — ${seenEmitters.size} file(s) call the tree update emitter, ${seenProducers.size} build boundary values, all listed.`,
);
