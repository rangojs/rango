import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rango } from "@rangojs/router/vite";
import { productionDefines } from "../../../../tools/vite-define";

// Dedicated #587 build-fixture app (own projectRoot -> own dist/ and staged-asset
// dir), so the prerender-onerror build tests never share or race the dist/ of any
// other e2e app. `prerender.onError` is flipped to "warn" via env so the same app
// covers both the default-fail and warn paths.
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    rango(
      process.env.RANGO_TEST_PRERENDER_ONERROR === "warn"
        ? { prerender: { onError: "warn" } }
        : undefined,
    ),
  ],
  define: productionDefines(command),
}));
