export interface LoaderResolveContext {
  parentURL?: string;
  conditions?: readonly string[];
  importAttributes?: Record<string, string>;
}

export interface LoaderResolveResult {
  shortCircuit?: boolean;
  url: string;
  format?: "module" | "commonjs" | "json" | "wasm" | null;
  importAttributes?: Record<string, string>;
}

export type NextResolve = (
  specifier: string,
  context?: LoaderResolveContext,
) => Promise<LoaderResolveResult>;

export function resolve(
  specifier: string,
  context: LoaderResolveContext,
  nextResolve: NextResolve,
): Promise<LoaderResolveResult>;
