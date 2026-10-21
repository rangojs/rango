/** One "use server" module in plugin-rsc's server-reference map. */
export interface ServerReferenceMeta {
  referenceKey: string;
  importId: string;
  exportNames: string[];
}

/**
 * The production `virtual:vite-rsc/server-references` module as plugin-rsc
 * 0.5.36 generates it (dist/plugin-*.js, `createVirtualPlugin(
 * "vite-rsc/server-references")`), for `metas` in that order.
 */
export function pluginRscServerReferences(
  metas: readonly ServerReferenceMeta[],
): string {
  let code = "";
  for (const meta of metas) {
    const key = JSON.stringify(meta.referenceKey);
    const id = JSON.stringify(meta.importId);
    const exports = meta.exportNames
      .map((name) => (name === "default" ? "default: _default" : name))
      .sort();
    code += `
  ${key}: async () => {
    const {${exports}} = await import(${id});
    return {${exports}};
  },
`;
  }
  return `export default {${code}};\n`;
}
