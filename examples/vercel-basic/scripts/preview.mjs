// Long-running preview server for the assembled .vercel/output, used by the
// Playwright production fixture (and handy for manual local preview of the
// Vercel function, which `vite preview` cannot serve — it only serves static
// client assets, not the RSC function). Prints `http://localhost:<port>` so the
// fixture can discover the port. Honors PORT (0 = ephemeral).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVercelOutputServer } from "./serve-vercel-output.mjs";

const appRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const server = await createVercelOutputServer(
  path.join(appRoot, ".vercel", "output"),
);

const port = Number(process.env.PORT) || 0;
server.listen(port, () => {
  console.log(`Vercel preview: http://localhost:${server.address().port}`);
});
