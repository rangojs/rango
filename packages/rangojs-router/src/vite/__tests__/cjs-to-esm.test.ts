import { describe, it, expect } from "vitest";
import { createCjsToEsmPlugin } from "../plugins/cjs-to-esm.js";

type DrivablePlugin = ReturnType<typeof createCjsToEsmPlugin> & {
  configResolved: (config: any) => void;
  transform: (this: any, code: string, id: string) => any;
};

const ENTRY_ID = "/abs/vendor/react-server-dom/client.browser.js";

describe("cjs-to-esm: vendor variant tracks Vite resolved mode", () => {
  it("emits the production variant when config.isProduction is true", () => {
    const plugin = createCjsToEsmPlugin() as DrivablePlugin;
    plugin.configResolved({ isProduction: true });

    const result = plugin.transform.call({}, "", ENTRY_ID);
    expect(result).not.toBeNull();
    expect(result.code).toContain(
      "react-server-dom-webpack-client.browser.production.js",
    );
    expect(result.code).not.toContain(".development.js");
  });

  it("emits the development variant when config.isProduction is false", () => {
    const plugin = createCjsToEsmPlugin() as DrivablePlugin;
    plugin.configResolved({ isProduction: false });

    const result = plugin.transform.call({}, "", ENTRY_ID);
    expect(result).not.toBeNull();
    expect(result.code).toContain(
      "react-server-dom-webpack-client.browser.development.js",
    );
    expect(result.code).not.toContain(".production.js");
  });

  it("defaults to the development variant before configResolved runs", () => {
    const plugin = createCjsToEsmPlugin() as DrivablePlugin;

    const result = plugin.transform.call({}, "", ENTRY_ID);
    expect(result).not.toBeNull();
    expect(result.code).toContain(
      "react-server-dom-webpack-client.browser.development.js",
    );
  });
});
