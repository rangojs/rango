// Re-export @vitejs/plugin-rsc/ssr for internal use by virtual entries
export { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";

// Re-export renderToReadableStream with proper typing for SSRDependencies
export { renderToReadableStream } from "react-dom/server.edge";
