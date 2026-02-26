export interface HandlerTransformConfig {
  fnName: string;
  brand: string;
}

export interface CreateExportBinding {
  localName: string;
  exportNames: string[];
  callExprStart: number;
  callOpenParenPos: number;
  callCloseParenPos: number;
  argCount: number;
  statementEnd: number;
}

export interface StrictCreateTransformConfig {
  fnName: "createLoader" | "createHandle" | "createLocationState";
}

export const PRERENDER_CONFIG: HandlerTransformConfig = {
  fnName: "Prerender",
  brand: "prerenderHandler",
};

export const STATIC_CONFIG: HandlerTransformConfig = {
  fnName: "Static",
  brand: "staticHandler",
};

export const STRICT_CREATE_CONFIGS: StrictCreateTransformConfig[] = [
  { fnName: "createLoader" },
  { fnName: "createHandle" },
  { fnName: "createLocationState" },
];

export interface ExposeInternalIdsApi {
  /** Tracks absolute module IDs that contain prerender handler exports.
   *  key: absolute module ID (filesystem path)
   *  value: array of export names (e.g., ["ArticlesIndex", "ArticleDetail"]) */
  prerenderHandlerModules: Map<string, string[]>;
  /** Tracks absolute module IDs that contain static handler exports.
   *  key: absolute module ID (filesystem path)
   *  value: array of export names (e.g., ["DocsNav", "DocShell"]) */
  staticHandlerModules: Map<string, string[]>;
}
