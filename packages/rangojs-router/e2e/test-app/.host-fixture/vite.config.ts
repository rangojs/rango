import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";

// E2e fixture: a node-preset host router (createHostRouter) with two sub-apps,
// proving a host app renders through rango's generated host RSC entry. Lives in a
// dot-dir so the parent test-app's createRouter discovery (which skips dot-dirs)
// ignores it.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), rango({ preset: "node" })],
  // Dedicated optimizeDeps cache. This fixture has no package.json, so vite would
  // otherwise resolve the cache to the parent test-app's node_modules/.vite, which
  // is shared with test-app's own dev server (running concurrently during e2e) --
  // the two clobber each other's pre-bundle (ERR_OUTDATED_OPTIMIZED_DEP), breaking
  // the dev client entry import and hydration. Isolating the cache fixes it.
  cacheDir: ".vite",
  // Allow arbitrary Host headers so an unmatched host reaches the host router
  // (which 404s via the generated entry) instead of vite's host check (403).
  server: { allowedHosts: true },
  preview: { allowedHosts: true },
});
