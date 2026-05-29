// Imported only via the "@parity/*" specifier, resolved by the
// `test-parity-alias` resolveId plugin in vite.config.ts -- NOT by a
// resolve.alias entry. Consumed by build-time Static/Prerender handlers to
// assert the cloudflare discovery runner forwards third-party resolvers
// (the vite-tsconfig-paths scenario, issue #500).
export const PARITY_MARKER = "resolveid-plugin-parity-ok";
