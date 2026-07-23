import type { Plugin } from "vite";
import { createRangoDebugger, createCounter, NS } from "../debug.js";
import { computeProductionHash } from "./client-ref-hashing.js";
import { registerServerReferenceRegex } from "./server-reference-pattern.js";

const debug = createRangoDebugger(NS.transform);

/**
 * Replace dev-style server-reference ids with their production hashes. The temp
 * server renders Static/Prerender in a dev/serve Vite server, so plugin-rsc mints
 * a dev-style id (e.g. "/src/urls/prerender.tsx"); rewriting only the id (group 2)
 * leaves the hoisted function and its trailing encrypted .bind(...) untouched.
 * Exported for testing; used by hashServerRefs. Returns null if nothing changed.
 */
export function transformServerRefs(
  code: string,
  projectRoot: string,
): string | null {
  if (!code.includes("registerServerReference")) return null;

  let hasReplacement = false;
  const result = code.replace(
    registerServerReferenceRegex(),
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
