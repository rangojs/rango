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
// Cached per process so the temp server (created during the main build's
// buildStart) and the main build share one key. Overridable via
// RANGO_ENCRYPTION_KEY for a stable key across builds/deploys; otherwise a fresh
// key is generated per build (matching plugin-rsc's default posture, where the
// key is emitted into the build output regardless).
let cachedKey: string | undefined;

export function buildEncryptionKey(): string {
  cachedKey ??=
    process.env.RANGO_ENCRYPTION_KEY ?? randomBytes(32).toString("base64");
  return cachedKey;
}

// The value plugin-rsc inlines as `export default () => (<expr>)`. A JSON string
// literal, so the emitted runtime key module is a plain base64 string.
export function defineEncryptionKeyExpr(): string {
  return JSON.stringify(buildEncryptionKey());
}
