import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
import { Document } from "./components/Document.js";

// Store the last onError call for e2e test verification.
// Use globalThis to ensure the same mutable slot is shared across
// Vite SSR module re-evaluations (module-level `let` and objects
// can be duplicated when the module is re-evaluated by HMR or
// the RSC environment runner).
export interface OnErrorRecord {
  phase: string;
  message: string;
  metadata?: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __testOnErrorCall: OnErrorRecord | null | undefined;
}

export function getLastOnErrorCall(): OnErrorRecord | null {
  return globalThis.__testOnErrorCall ?? null;
}
export function resetLastOnErrorCall() {
  globalThis.__testOnErrorCall = null;
}

export const router = createRouter({
  document: Document,
  timeout: 10000,
  ssr: {
    resolveStreaming: async ({ url }) => {
      if (url.pathname === "/timeout/slow-html-setup") {
        await new Promise((resolve) => setTimeout(resolve, 20000));
      }
      return "stream";
    },
  },
  onError: (context) => {
    globalThis.__testOnErrorCall = {
      phase: context.phase,
      message: context.error.message,
      metadata: context.metadata,
    };
  },
  urls: urlpatterns,
});
