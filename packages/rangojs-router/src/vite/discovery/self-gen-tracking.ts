/**
 * Self-Generated File Tracking
 *
 * Tracks gen files recently written by the discovery plugin so the
 * file watcher can distinguish self-triggered change events from
 * manual edits.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DiscoveryState } from "./state.js";

export function markSelfGenWrite(
  state: DiscoveryState,
  filePath: string,
  content: string,
): void {
  const hash = createHash("sha256").update(content).digest("hex");
  state.selfWrittenGenFiles.set(filePath, { at: Date.now(), hash });
}

export function consumeSelfGenWrite(
  state: DiscoveryState,
  filePath: string,
): boolean {
  const info = state.selfWrittenGenFiles.get(filePath);
  if (!info) return false;
  if (Date.now() - info.at > state.SELF_WRITE_WINDOW_MS) {
    state.selfWrittenGenFiles.delete(filePath);
    return false;
  }
  try {
    const current = readFileSync(filePath, "utf-8");
    const currentHash = createHash("sha256").update(current).digest("hex");
    if (currentHash === info.hash) {
      state.selfWrittenGenFiles.delete(filePath);
      return true;
    }
    // Hash mismatch: file was changed externally. Keep the entry so a
    // subsequent watcher event from our own write can still be consumed
    // (e.g. when multiple Vite servers watch the same directory).
    return false;
  } catch {
    state.selfWrittenGenFiles.delete(filePath);
    return false;
  }
}
