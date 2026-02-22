import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [
    react(),
    rango({
      router: "./src/router.tsx",
    }),
    nitro(),
  ],
  nitro: {
    preset: "vercel",
    serverDir: "server",
  },
});
