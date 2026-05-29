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
  return checkSelfGenWrite(state, filePath, true);
}

/**
 * Non-consuming variant. Used by the `handleHotUpdate` plugin hook to
 * suppress vite's HMR cascade for our own gen-file writes WITHOUT
 * consuming the entry — `consumeSelfGenWrite` (called later from the
 * chokidar `change` handler in `handleRouteFileChange`) still needs to
 * see and consume the same entry to short-circuit our regen path.
 *
 * Both hooks fire for the same file change event:
 *   - `handleHotUpdate` runs first (vite's HMR pipeline).
 *   - chokidar `change` callback runs after (filesystem watcher).
 */
export function peekSelfGenWrite(
  state: DiscoveryState,
  filePath: string,
): boolean {
  return checkSelfGenWrite(state, filePath, false);
}

function checkSelfGenWrite(
  state: DiscoveryState,
  filePath: string,
  consume: boolean,
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
      if (consume) state.selfWrittenGenFiles.delete(filePath);
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
