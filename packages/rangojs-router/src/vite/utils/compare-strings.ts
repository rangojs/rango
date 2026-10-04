/**
 * Code-unit order, the same on every machine. Generated modules and the cache
 * version inputs are sorted with it: `localeCompare` depends on the build
 * machine's ICU data, and build output has to be byte-identical across machines
 * (discovery/build-versions.ts hashes it).
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
