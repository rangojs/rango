import { join } from "path";

// @ts-expect-error -- built output has no declaration file
const handler: (req: Request) => Promise<Response> = (await import("./dist/rsc/index.js")).default;
const clientDir = join(import.meta.dir, "dist", "client");

Bun.serve({
  port: Number(process.env.PORT) || 4173,
  async fetch(request) {
    const url = new URL(request.url);

    // Serve static files from dist/client/
    const filePath = join(clientDir, url.pathname);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // Fall back to the RSC handler
    return handler(request);
  },
});

console.log(`Bun server listening on http://localhost:${Number(process.env.PORT) || 4173}`);
