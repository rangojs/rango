import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
import { Document } from "./components/Document.js";

// Store the last onError call for e2e test verification
export interface OnErrorRecord {
  phase: string;
  message: string;
  metadata?: Record<string, unknown>;
}
export let lastOnErrorCall: OnErrorRecord | null = null;
export function resetLastOnErrorCall() {
  lastOnErrorCall = null;
}

export const router = createRouter({
  document: Document,
  timeout: 2000,
  onError: (context) => {
    lastOnErrorCall = {
      phase: context.phase,
      message: context.error.message,
      metadata: context.metadata,
    };
  },
  urls: urlpatterns,
});
