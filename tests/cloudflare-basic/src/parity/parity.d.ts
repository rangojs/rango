// "@parity/*" is intentionally absent from tsconfig "paths" so that Vite's
// native resolve.tsconfigPaths cannot resolve it -- that keeps the
// resolveId-plugin parity test (test-parity-alias in vite.config.ts) a true
// guard, independent of the native-tsconfigPaths forwarding. This ambient
// declaration gives tsc the type for the plugin-resolved specifier.
declare module "@parity/marker.js" {
  export const PARITY_MARKER: string;
}
