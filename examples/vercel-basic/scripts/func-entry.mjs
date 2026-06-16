// Vercel Node Function launcher.
//
// Bundled by scripts/vercel-build.mjs into .vercel/output/functions/index.func/
// index.mjs: srvx and @vercel/functions are inlined, while "./rsc/index.js" is
// kept as a runtime-relative import resolved inside the .func directory (the
// self-contained Rango RSC server bundle copied there at assemble time).
//
// The Vercel Node launcher (launcherType: "Nodejs") invokes a Node (req, res)
// handler, not a Web fetch handler. srvx's toNodeHandler bridges the Rango Web
// fetch handler to (req, res) and pipes the streamed Response to the Node
// response (incremental RSC/HTML streaming), which is why .vc-config.json sets
// supportsResponseStreaming: true.
import { toNodeHandler } from "srvx/node";
import { waitUntil } from "@vercel/functions";
import rscHandler from "./rsc/index.js";

const onVercel = Boolean(process.env.VERCEL);

// rscHandler is the Rango RSC fetch handler: (request, input) => Promise<Response>.
// Forward process.env as the router env and a minimal ExecutionContext carrying
// Vercel's waitUntil so cache writes and background revalidation run off the
// response path. Off-platform (local smoke test) waitUntil is omitted so writes
// settle inline.
const fetchHandler = (request) =>
  rscHandler(request, {
    env: process.env,
    ctx: onVercel ? { waitUntil } : undefined,
  });

export default toNodeHandler(fetchHandler);
