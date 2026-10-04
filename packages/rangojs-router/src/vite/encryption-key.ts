import { randomBytes } from "node:crypto";

// plugin-rsc encrypts inline-action bound args with a key read from
// `virtual:vite-rsc/encryption-key`, which defaults to a fresh random key PER
// plugin instance. The build-discovery temp server (which renders Static/
// Prerender output) is a separate plugin instance from the main build, so by
// default it encrypts prerendered bound args with a key the runtime never has --
// `decryptActionBoundArgs` then fails on invocation. We hand both the SAME key
// via plugin-rsc's `defineEncryptionKey` so build-time-encrypted bound args
// decrypt at runtime.
//
// Resolved once per process so the temp server (created during the main
// build's buildStart) and the main build share one key. Source order:
// rango({ encryptionKey }), then RANGO_ENCRYPTION_KEY, then a key generated for
// this build. Only the first two are stable across builds.
//
// The key is part of the cache version of every router whose server code
// encrypts with it (discovery/build-versions.ts adds the emitted key file to
// that router's hash): a payload cached under the old key carries bound args
// the new build cannot decrypt. So a generated key gives those routers a new
// version on every build, which is correct and also means their cache is
// cleared on every deploy.

/** AES key sizes Web Crypto imports for AES-GCM, in bytes. */
const AES_KEY_BYTES: ReadonlySet<number> = new Set([16, 24, 32]);

const EXPECTED =
  "a base64-encoded AES key of 16, 24 or 32 bytes (openssl rand -base64 32)";

interface ResolvedEncryptionKey {
  key: string;
  /** True when the consumer supplied the key (option or env variable). */
  stable: boolean;
}

let resolvedKey: ResolvedEncryptionKey | undefined;

/**
 * Throws unless `value` is the base64 form of an AES key (16, 24 or 32 bytes).
 * `source` names where the value came from, for the message.
 */
export function assertValidEncryptionKey(value: unknown, source: string): void {
  if (typeof value !== "string") {
    throw new Error(
      `[rango] ${source} must be a string, received ${typeof value}. Expected ${EXPECTED}.`,
    );
  }
  if (value === "") {
    throw new Error(
      `[rango] ${source} is an empty string. Unset it to generate a key per build, ` +
        `or set it to ${EXPECTED}.`,
    );
  }
  const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? Buffer.from(value, "base64")
    : undefined;
  // Buffer.from tolerates malformed base64 by dropping what it cannot decode;
  // the round-trip rejects those inputs instead of using a shorter key.
  if (
    !bytes ||
    bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
  ) {
    throw new Error(
      `[rango] ${source} is not valid base64. Expected ${EXPECTED}.`,
    );
  }
  if (!AES_KEY_BYTES.has(bytes.length)) {
    throw new Error(
      `[rango] ${source} decodes to ${bytes.length} bytes. Expected ${EXPECTED}.`,
    );
  }
}

/**
 * Resolve the build's encryption key from rango({ encryptionKey }) or the
 * RANGO_ENCRYPTION_KEY fallback, validating whichever is set. Called by
 * rango() at config time, before any plugin-rsc instance reads the key, so an
 * invalid key fails the config load instead of the first encrypted action.
 * A key generated earlier in the process is kept when neither source is set:
 * the discovery temp server must encrypt with the main build's key.
 */
export function configureEncryptionKey(option: string | undefined): void {
  if (option !== undefined) {
    assertValidEncryptionKey(option, "rango({ encryptionKey })");
    resolvedKey = { key: option, stable: true };
    return;
  }
  const fromEnv = process.env.RANGO_ENCRYPTION_KEY;
  if (fromEnv !== undefined) {
    assertValidEncryptionKey(fromEnv, "RANGO_ENCRYPTION_KEY");
    resolvedKey = { key: fromEnv, stable: true };
    return;
  }
  if (resolvedKey && !resolvedKey.stable) return;
  resolvedKey = { key: randomBytes(32).toString("base64"), stable: false };
}

function resolved(): ResolvedEncryptionKey {
  if (!resolvedKey) configureEncryptionKey(undefined);
  return resolvedKey!;
}

export function buildEncryptionKey(): string {
  return resolved().key;
}

/** False when this build generated its own key (it differs on every build). */
export function isEncryptionKeyStable(): boolean {
  return resolved().stable;
}

// The value plugin-rsc inlines as `export default () => (<expr>)`. A JSON string
// literal, so the emitted runtime key module is a plain base64 string.
export function defineEncryptionKeyExpr(): string {
  return JSON.stringify(buildEncryptionKey());
}

/** @internal Test seam: forget the process-wide key. */
export function resetEncryptionKeyForTests(): void {
  resolvedKey = undefined;
}
