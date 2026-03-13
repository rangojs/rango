import type { Plugin } from "vite";

/**
 * Vite plugin that triggers a full browser reload when Ctrl+R is pressed
 * in the terminal running the dev server.
 *
 * Usage:
 * ```ts
 * import { poke } from "@rangojs/router/vite";
 *
 * export default defineConfig({
 *   plugins: [rango(), poke()],
 * });
 * ```
 */
export function poke(): Plugin {
  return {
    name: "vite-plugin-poke",
    apply: "serve",

    configureServer(server) {
      const stdin = process.stdin;

      // Raw mode delivers individual keystrokes as immediate single-byte
      // events instead of waiting for Enter (cooked/line-buffered mode).
      // Without it, Ctrl+R (0x12) is never delivered as a discrete byte.
      // When stdin is a pipe (CI, spawned process) setRawMode is unavailable
      // but data already arrives unbuffered, so the isTTY guard suffices.
      const previousRawMode = stdin.isTTY ? stdin.isRaw : null;
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }

      const onData = (data: Buffer) => {
        if (data.length !== 1) return;

        // Ctrl+C (0x03) — defensive fallback. This plugin enables raw mode
        // before Vite's internal stdin handler is registered (user plugins
        // run first), so there is a brief window where Ctrl+C would be
        // swallowed. Re-emit SIGINT so the process exits as expected.
        if (data[0] === 0x03) {
          process.emit("SIGINT", "SIGINT");
          return;
        }

        // Ctrl+R = 0x12 in raw mode
        if (data[0] === 0x12) {
          server.hot.send({ type: "full-reload", path: "*" });
          server.config.logger.info("  browser reload (ctrl+r)", {
            timestamp: true,
          });
        }
      };

      stdin.on("data", onData);

      server.httpServer?.on("close", () => {
        stdin.off("data", onData);
        if (stdin.isTTY && previousRawMode !== null) {
          stdin.setRawMode(previousRawMode);
        }
      });
    },
  };
}
