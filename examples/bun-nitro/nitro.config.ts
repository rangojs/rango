import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  compatibilityDate: "2025-01-01",
  preset: "vercel_edge",
  srcDir: "server",
  publicAssets: [
    {
      dir: "../dist/client",
      baseURL: "/",
    },
  ],
});
