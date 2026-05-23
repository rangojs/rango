// Imported only via the "@parity/*" specifier, which is resolved by the
// `test-parity-alias` resolveId plugin in vite.config.ts -- NOT by a
// resolve.alias entry. This exercises the discovery runner's ability to honor
// third-party resolveId plugins (the vite-tsconfig-paths scenario from
// issue #500) during build-time static/prerender rendering.
export const PARITY_MARKER = "resolveid-plugin-parity-ok";
