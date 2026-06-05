// Collect the `"use client"` client-reference keys reachable from an error /
// notFound boundary registration, for routing them into the dedicated
// `app-fallback` chunk (see vite/utils/client-chunks.ts).
//
// A boundary registration is not always a bare client element. The common,
// load-bearing pattern wraps the client boundary in providers a thrown handler
// needs (the layout that would normally supply them did not mount):
//
//   defaultErrorBoundary: ({ error }) => (
//     <FallbackIntl locales={...}>
//       <ThemedError error={error} />   // <- the real "use client" boundary
//     </FallbackIntl>
//   )
//
// So the value may be (a) a handler FUNCTION returning a tree, or (b) an element
// tree with the client boundary nested below server wrappers. We:
//   1. If it's a function, CALL it with synthetic props to get the returned tree.
//      This only constructs JSX — the inner components are element `type`s, never
//      invoked — so no hooks run. Guarded: a boundary that needs a real render
//      context (request globals, etc.) throws and is skipped (graceful: it simply
//      stays on the default grouping, as before).
//   2. Walk the resulting tree and report every element whose `.type` is a
//      plugin-rsc client reference.
//
// Limit: a boundary that *conditionally* renders different client components based
// on the runtime error cannot be resolved statically — only the branch taken with
// the synthetic error is seen. Such cases fall back to the default chunk; the
// custom `clientChunks` function is the escape hatch.

const CLIENT_REF = Symbol.for("react.client.reference");
const MAX_DEPTH = 40;

// Synthetic props covering the error-boundary (`{ error, reset }`) and notFound
// (`{ pathname }`) handler shapes. The handler destructures what it needs.
const SYNTHETIC_PROPS = {
  error: new Error("rango: build-time fallback-chunk discovery"),
  reset: () => {},
  pathname: "/",
  info: { componentStack: "" },
};

interface MaybeElement {
  type?: { $$typeof?: symbol; $$id?: string };
  props?: Record<string, unknown>;
}

function isReactNodeLike(v: unknown): boolean {
  return (
    Array.isArray(v) ||
    (typeof v === "object" && v !== null && "$$typeof" in (v as object))
  );
}

function walkElementTree(
  node: unknown,
  report: (refKey: string) => void,
  depth: number,
): void {
  if (node == null || depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (const child of node) walkElementTree(child, report, depth + 1);
    return;
  }
  if (typeof node !== "object") return;

  const el = node as MaybeElement;
  const type = el.type;
  if (type?.$$typeof === CLIENT_REF && typeof type.$$id === "string") {
    // $$id is `<referenceKey>#<exportName>` in build mode — keep the referenceKey.
    report(type.$$id.split("#")[0]);
  }

  const props = el.props;
  if (props && typeof props === "object") {
    // Children are always nodes; other props are followed only when they look
    // like React nodes (slots/icons), never arbitrary data objects.
    walkElementTree(props.children, report, depth + 1);
    for (const key in props) {
      if (key === "children") continue;
      const value = props[key];
      if (isReactNodeLike(value)) walkElementTree(value, report, depth + 1);
    }
  }
}

/**
 * Report every `"use client"` client-reference key reachable from a single
 * error/notFound boundary registration (handler function or element tree).
 */
export function collectFallbackClientRefs(
  boundary: unknown,
  report: (refKey: string) => void,
): void {
  try {
    let node = boundary;
    if (typeof node === "function") {
      node = (node as (props: unknown) => unknown)(SYNTHETIC_PROPS);
    }
    walkElementTree(node, report, 0);
  } catch {
    // The boundary needs a real render context (request globals, hooks at the
    // top level) or its tree has hostile getters. Its client refs can't be
    // resolved statically — skip. It stays on the default grouping (no
    // regression vs. not collecting), and the custom clientChunks fn is the
    // escape hatch for such cases.
  }
}
