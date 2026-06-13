import type { Plugin } from "vite";

/**
 * Vite plugin that triggers a full browser reload from terminal input.
 *
 * This plugin is intentionally passive:
 * - it never enables raw mode on stdin
 * - it never restores terminal state
 * - it reacts to Ctrl+R when that raw byte reaches the process
 * - it also supports safe line-based fallbacks like "e" + Enter
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
    name: "@rangojs/router:poke",
    apply: "serve",

    configureServer(server) {
      const stdin = process.stdin;
      const debug = process.env.RANGO_POKE_DEBUG === "1";

      const triggerReload = (source: string) => {
        server.hot.send({ type: "full-reload", path: "*" });
        server.config.logger.info(`  browser reload (${source})`, {
          timestamp: true,
        });
      };

      const toBuffer = (chunk: string | Buffer): Buffer => {
        return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      };

      const formatChunk = (chunk: string | Buffer): string => {
        const data = toBuffer(chunk);
        const hex = Array.from(data)
          .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
          .join(" ");
        const ascii = Array.from(data)
          .map((byte) => {
            if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
            if (byte === 0x0a) return "\\n";
            if (byte === 0x0d) return "\\r";
            if (byte === 0x09) return "\\t";
            return ".";
          })
          .join("");
        return `len=${data.length} hex=[${hex}] ascii="${ascii}"`;
      };

      const readCtrlR = (chunk: string | Buffer): boolean => {
        const data =
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        return data.length === 1 && data[0] === 0x12;
      };

      const readSubmittedCommands = (chunk: string | Buffer): string[] => {
        const text = toBuffer(chunk)
          .toString("utf8")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");

        if (!text.includes("\n")) return [];

        const lines = text.split("\n");
        lines.pop();
        return lines;
      };

      if (debug) {
        server.config.logger.info(
          `  poke debug enabled (isTTY=${stdin.isTTY ? "yes" : "no"}, isRaw=${stdin.isTTY ? (stdin.isRaw ? "yes" : "no") : "n/a"})`,
          { timestamp: true },
        );
      }

      if (stdin.isTTY) {
        server.config.logger.info(
          "  poke ready: press e + enter to reload browser (ctrl+r also works when available)",
          { timestamp: true },
        );
      }

      const onData = (data: string | Buffer) => {
        if (debug) {
          server.config.logger.info(`  poke stdin ${formatChunk(data)}`, {
            timestamp: true,
          });
        }

        // Only react to the exact Ctrl+R byte when some host terminal or
        // wrapper already delivers it to this process. We intentionally do
        // not enable raw mode here because that can steal Vite shortcuts
        // like "r" / "q" and interfere with terminal-level controls.
        if (readCtrlR(data)) {
          triggerReload("ctrl+r");
          return;
        }

        for (const command of readSubmittedCommands(data)) {
          if (command === "e") {
            triggerReload("e+enter");
            return;
          }

          if (command === "\u001br") {
            triggerReload("option+r+enter");
            return;
          }
        }
      };

      stdin.on("data", onData);

      server.httpServer?.on("close", () => {
        stdin.off("data", onData);
      });
    },
  };
}
