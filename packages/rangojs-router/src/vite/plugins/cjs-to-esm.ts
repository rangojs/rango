import type { Plugin } from "vite";
import { createRangoDebugger, NS } from "../debug.js";

const debug = createRangoDebugger(NS.transform);

/**
 * Transform CJS vendor files from @vitejs/plugin-rsc to ESM for browser compatibility.
 * The react-server-dom vendor files are shipped as CJS which doesn't work in browsers.
 */
export function createCjsToEsmPlugin(): Plugin {
  return {
    name: "@rangojs/router:cjs-to-esm",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?")[0].replaceAll("\\", "/");

      if (cleanId.includes("vendor/react-server-dom/client.browser.js")) {
        const isProd = process.env.NODE_ENV === "production";
        const cjsFile = isProd
          ? "./cjs/react-server-dom-webpack-client.browser.production.js"
          : "./cjs/react-server-dom-webpack-client.browser.development.js";

        debug?.("cjs-to-esm entry redirect %s", id);
        return {
          code: `export * from "${cjsFile}";`,
          map: null,
        };
      }

      if (
        cleanId.includes("vendor/react-server-dom/cjs/") &&
        cleanId.includes("client.browser")
      ) {
        let transformed = code;

        const licenseMatch = transformed.match(/^\/\*\*[\s\S]*?\*\//);
        const license = licenseMatch ? licenseMatch[0] : "";
        if (license) {
          transformed = transformed.slice(license.length);
        }

        transformed = transformed.replace(/^\s*["']use strict["'];\s*/, "");

        transformed = transformed.replace(
          /^\s*["']production["']\s*!==\s*process\.env\.NODE_ENV\s*&&\s*\(function\s*\(\)\s*\{/,
          "",
        );

        transformed = transformed.replace(/\}\)\(\);?\s*$/, "");

        transformed = transformed.replace(
          /var\s+React\s*=\s*require\s*\(\s*["']react["']\s*\)\s*,[\s\n]+ReactDOM\s*=\s*require\s*\(\s*["']react-dom["']\s*\)\s*,/g,
          'import React from "react";\nimport ReactDOM from "react-dom";\nvar ',
        );

        transformed = transformed.replace(
          /var\s+ReactDOM\s*=\s*require\s*\(\s*["']react-dom["']\s*\)\s*,/g,
          'import ReactDOM from "react-dom";\nvar ',
        );

        transformed = transformed.replace(
          /exports\.(\w+)\s*=\s*function\s*\(/g,
          "export function $1(",
        );

        transformed = transformed.replace(
          /exports\.(\w+)\s*=/g,
          "export const $1 =",
        );

        transformed = license + "\n" + transformed;

        debug?.("cjs-to-esm body rewrite %s", id);
        return {
          code: transformed,
          map: null,
        };
      }

      return null;
    },
  };
}
