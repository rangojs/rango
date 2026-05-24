// Resolved ONLY by Vite 8's native resolve.tsconfigPaths (tsconfig "paths"
// maps "@native/*" -> ./src/native-paths/*). There is no resolve.alias entry
// and no resolveId plugin for "@native/*", so reaching this through build-time
// Static/Prerender handlers asserts the discovery runner forwards the native
// tsconfigPaths flag into its temp server. Vite 8 supersedes vite-tsconfig-paths
// with this built-in flag; see utils/forward-user-plugins.ts.
export const NATIVE_PATHS_MARKER = "native-tsconfig-paths-ok";
