import type { Plugin } from "vite";
import { relative } from "node:path";
import { createHash } from "node:crypto";
import { createRangoDebugger, createCounter, NS } from "../debug.js";

const debug = createRangoDebugger(NS.transform);

// Dev-mode client-reference key prefixes emitted by @vitejs/plugin-rsc
const CLIENT_PKG_PROXY_PREFIX =
  "/@id/__x00__virtual:vite-rsc/client-package-proxy/";
const CLIENT_IN_SERVER_PKG_PROXY_PREFIX =
  "/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/";
const FS_PREFIX = "/@fs/";

/**
 * Compute the production SHA-256 hash for a dev-mode client reference key.
 * Mirrors the hashing logic in @vitejs/plugin-rsc's build mode:
 *   - Local files: hashString(toRelativeId(id)) where toRelativeId = relative(root, id)
 *   - Package proxies: hashString(packageSource)
 *   - client-in-server-package proxies: hashString(relative(root, decodedAbsPath))
 *
 * Returns the input unchanged if it doesn't match a known dev-mode pattern
 * (e.g., already a production hash).
 */
/**
 * The production client-reference key hash: `sha256(relativeId).slice(0,12)`,
 * matching @vitejs/plugin-rsc's `hashString`. Exported so the client-chunks
 * strategy can hash a `clientChunks` callback's `meta.normalizedId` (already the
 * project-root-relative id) and compare it against fallback hashes collected
 * during discovery.
 */
export function hashRefKey(relativeId: string): string {
  return createHash("sha256").update(relativeId).digest("hex").slice(0, 12);
}

export function computeProductionHash(
  projectRoot: string,
  refKey: string,
): string {
  let toHash: string;

  if (refKey.startsWith(CLIENT_PKG_PROXY_PREFIX)) {
    // /@id/__x00__virtual:vite-rsc/client-package-proxy/<pkg> -> hash("<pkg>")
    toHash = refKey.slice(CLIENT_PKG_PROXY_PREFIX.length);
  } else if (refKey.startsWith(CLIENT_IN_SERVER_PKG_PROXY_PREFIX)) {
    // /@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/<encodedAbsPath>
    const absPath = decodeURIComponent(
      refKey.slice(CLIENT_IN_SERVER_PKG_PROXY_PREFIX.length),
    );
    toHash = relative(projectRoot, absPath).replaceAll("\\", "/");
  } else if (refKey.startsWith(FS_PREFIX)) {
    // /@fs/abs/path.tsx -> hash(relative(root, "/abs/path.tsx"))
    const absPath = refKey.slice(FS_PREFIX.length - 1); // keep leading /
    toHash = relative(projectRoot, absPath).replaceAll("\\", "/");
  } else if (refKey.startsWith("/")) {
    // /src/Button.tsx -> hash("src/Button.tsx")
    toHash = refKey.slice(1);
  } else {
    // Already hashed or unknown format — return unchanged
    return refKey;
  }

  return hashRefKey(toHash);
}

// Regex to match registerClientReference() calls as emitted by @vitejs/plugin-rsc.
// Captures the reference key (second argument) from the call.
// Handles two proxy forms: parenthesized expression `(expr)` and arrow-throw `() => { ... }`.
const REGISTER_CLIENT_REF_RE =
  /registerClientReference\(\s*(?:(?:\([^)]*\))|(?:\(\)[\s\S]*?\}))\s*,\s*"([^"]+)"\s*,\s*"[^"]+"\s*\)/g;

/**
 * Transform source code by replacing dev-mode client reference keys with
 * production hashes. Exported for testing; used internally by hashClientRefs.
 * Returns null if no replacements were made.
 */
export function transformClientRefs(
  code: string,
  projectRoot: string,
): string | null {
  if (!code.includes("registerClientReference")) return null;

  let hasReplacement = false;
  const result = code.replace(
    REGISTER_CLIENT_REF_RE,
    (match, refKey: string) => {
      const hash = computeProductionHash(projectRoot, refKey);
      if (hash === refKey) return match;
      hasReplacement = true;
      return match.replace(`"${refKey}"`, `"${hash}"`);
    },
  );

  return hasReplacement ? result : null;
}

/**
 * Vite plugin that rewrites registerClientReference() calls in the RSC
 * environment, replacing dev-mode reference keys with production hashes.
 *
 * This runs AFTER the RSC plugin's transform so the Flight serializer
 * naturally emits production IDs, eliminating the need for post-build
 * regex replacement of Flight payloads.
 */
export function hashClientRefs(projectRoot: string): Plugin {
  const counter = createCounter(debug, "hash-client-refs");
  return {
    name: "@rangojs/router:hash-client-refs",
    // Run after the RSC plugin's transform (default enforce is normal)
    enforce: "post",
    applyToEnvironment(env) {
      return env.name === "rsc";
    },
    buildEnd() {
      counter?.flush();
    },
    transform(code, id) {
      const start = counter ? performance.now() : 0;
      try {
        const result = transformClientRefs(code, projectRoot);
        if (result === null) return;
        return { code: result, map: null };
      } finally {
        counter?.record(id, performance.now() - start);
      }
    },
  };
}
