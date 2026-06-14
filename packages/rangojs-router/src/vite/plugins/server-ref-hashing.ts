import type { Plugin } from "vite";
import { createRangoDebugger, createCounter, NS } from "../debug.js";
import { computeProductionHash } from "./client-ref-hashing.js";

const debug = createRangoDebugger(NS.transform);

// plugin-rsc's rsc:use-server transform emits
//   registerServerReference(<value>, "<id>", "<name>")
// where <id> is the module's normalized id. In a real build (command === "build")
// that id is the production hash; in a dev/serve server it is the dev-style
// module path (e.g. "/src/urls/prerender.tsx"). The leading <value> is a hoisted
// identifier (no top-level comma), and a trailing .bind(null,
// encryptActionBoundArgs(...)) lies OUTSIDE this call -- so matching only the
// call and replacing group 2 leaves the function and its bound args untouched.
const REGISTER_SERVER_REF_RE =
  /registerServerReference\(([^,]+),\s*"([^"]+)",\s*"([^"]+)"\)/g;

/**
 * Replace dev-style server-reference ids with their production hashes. Exported
 * for testing; used by hashServerRefs. Returns null if nothing changed.
 */
export function transformServerRefs(
  code: string,
  projectRoot: string,
): string | null {
  if (!code.includes("registerServerReference")) return null;

  let hasReplacement = false;
  const result = code.replace(
    REGISTER_SERVER_REF_RE,
    (match, _value: string, refKey: string) => {
      // The temp server is not a long-lived HMR server, so ids are bare; strip a
      // query suffix defensively so the hash matches plugin-rsc's manifest key.
      const cleanKey = refKey.split("?")[0]!;
      const hash = computeProductionHash(projectRoot, cleanKey);
      if (hash === cleanKey) return match;
      hasReplacement = true;
      return match.replace(`"${refKey}"`, `"${hash}"`);
    },
  );

  return hasReplacement ? result : null;
}

/**
 * Server-side analog of hashClientRefs. Runs in the build-discovery temp server
 * (a dev/serve Vite server, where plugin-rsc mints dev-style ids), rewriting
 * registerServerReference ids to production hashes AFTER plugin-rsc's
 * rsc:use-server transform (enforce:"post"), so the Flight serializer bakes the
 * production hash into the stored prerender/static payloads.
 *
 * Without this, a server-created action embedded in a prerendered/static Flight
 * is stored with a dev-style id that the production hash-keyed server-references
 * manifest cannot resolve -> "server reference not found" on a build-time-cache
 * hit. Mirrors hashClientRefs, which already does exactly this for the client
 * half of the same payload (which is why client refs in stored Flight are
 * already production hashes while server refs were not).
 */
export function hashServerRefs(projectRoot: string): Plugin {
  const counter = createCounter(debug, "hash-server-refs");
  return {
    name: "@rangojs/router:hash-server-refs",
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
        const result = transformServerRefs(code, projectRoot);
        if (result === null) return;
        return { code: result, map: null };
      } finally {
        counter?.record(id, performance.now() - start);
      }
    },
  };
}
