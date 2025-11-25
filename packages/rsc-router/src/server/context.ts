import { AsyncLocalStorage } from "node:async_hooks";
import type { ReactNode } from "react";
import type { Handler, LoaderDefinition, MiddlewareFn, ShouldRevalidateFn } from "../types";
import { invariant } from "../errors";
// ============================================================================
//  RSC Router Context
// ============================================================================

/**
 * Entry data structure for manifest
 */
export type EntryPropCommon = {
  id: string;
  shortCode: string; // Short identifier for network efficiency (e.g., "L0", "P1", "R2")
  parent: EntryData | null;
};
export type EntryPropDatas = {
  middleware: MiddlewareFn<any, any>[];
  revalidate: ShouldRevalidateFn<any, any>[];
};
/**
 * Loader entry stored in EntryData
 * Contains the loader definition and its revalidation rules
 */
export type LoaderEntry = {
  loader: LoaderDefinition<any>;
  revalidate: ShouldRevalidateFn<any, any>[];
};

export type EntryPropSegments = {
  loader: LoaderEntry[];
  layout: EntryData[];
  parallel: Record<`@${string}`, Handler<any, any> | ReactNode>[];
};

export type EntryData =
  | ({
      type: "route";
      handler: Handler<any, any>;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments)
  | ({
      type: "layout";
      handler: ReactNode | Handler<any, any>;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments)
  | ({
      type: "parallel";
      handler: Record<`@${string}`, Handler<any, any> | ReactNode>;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments);

/**
 * Context stored in AsyncLocalStorage
 */
interface HelperContext {
  manifest: Map<string, EntryData>;
  namespace: string;
  parent: EntryData | null;
  counters: Record<string, number>;
  forRoute?: string;
  mountIndex?: number;
}
export const RSCRouterContext: AsyncLocalStorage<HelperContext> =
  new AsyncLocalStorage<HelperContext>();

export const getContext = (): {
  context: AsyncLocalStorage<HelperContext>;
  getStore: () => HelperContext;
  getParent: () => EntryData | null;
  getOrCreateStore: (forRoute?: string) => HelperContext;
  getNextIndex: (
    type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate"
  ) => string;
  getShortCode: (
    type: "layout" | "parallel" | "route" | "loader"
  ) => string;
  run: <T>(
    namespace: string,
    parent: EntryData | null,
    callback: (...args: any[]) => T
  ) => T;
  runWithStore: <T>(
    store: HelperContext,
    namespace: string,
    parent: EntryData | null,
    callback: (...args: any[]) => T
  ) => T;
} => {
  const context = RSCRouterContext;

  return {
    context,
    getOrCreateStore: (forRoute?: string): HelperContext => {
      let store = RSCRouterContext.getStore();
      if (!store) {
        store = {
          manifest: new Map<string, EntryData>(),
          namespace: "",
          parent: null,
          forRoute,
          counters: {},
        } satisfies HelperContext;
      }
      return store;
    },
    getStore: (): HelperContext => {
      const store = context.getStore();
      if (!store) {
        throw new Error(
          "RSC Router context store is not available. Make sure to run within RSC Router context."
        );
      }
      return store;
    },
    getParent: (): EntryData | null => {
      const store = context.getStore();
      if (!store) {
        return null;
      }

      return store.parent;
    },
    getNextIndex: (
      type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate"
    ) => {
      const store = context.getStore();
      invariant(store, "No context RSCRouterContext available");
      store.counters[type] ??= 0;
      const index = store.counters[type];
      store.counters[type] = index + 1;
      return `$${type}.${index}`;
    },
    getShortCode: (type: "layout" | "parallel" | "route" | "loader") => {
      const store = context.getStore();
      invariant(store, "No context RSCRouterContext available");

      const parent = store.parent;
      const prefix = type === "layout" ? "L" : type === "parallel" ? "P" : type === "loader" ? "D" : "R";
      const mountPrefix = store.mountIndex !== undefined ? `M${store.mountIndex}` : "";

      if (!parent) {
        // Root entry: prefix with mount index and use mount-scoped counter
        const counterKey = mountPrefix ? `${mountPrefix}_root_${type}` : `root_${type}`;
        store.counters[counterKey] ??= 0;
        const index = store.counters[counterKey];
        store.counters[counterKey] = index + 1;
        return `${mountPrefix}${prefix}${index}`;
      } else {
        // Child entry: use parent-scoped counter (parent already has M prefix)
        const counterKey = `${parent.shortCode}_${type}`;
        store.counters[counterKey] ??= 0;
        const index = store.counters[counterKey];
        store.counters[counterKey] = index + 1;
        return `${parent.shortCode}${prefix}${index}`;
      }
    },
    runWithStore: <T>(
      store: HelperContext,
      namespace: string,
      parent: EntryData | null,
      callback: (...args: any[]) => T
    ): T => {
      return context.run(
        {
          manifest: store.manifest,
          namespace,
          parent: parent || null,
          counters: store.counters,
          forRoute: store.forRoute,
          mountIndex: store.mountIndex,
        },
        callback
      );
    },
    run: <T>(
      namespace: string,
      parent: EntryData | null,
      callback: (...args: any[]) => T
    ) => {
      const store = context.getStore();
      // Preserve parent counters to ensure globally unique shortCodes
      const counters = store?.counters || {};
      const manifest = store ? store.manifest : new Map<string, EntryData>();
      return context.run(
        {
          manifest,
          namespace,
          parent: parent || null,
          counters,
          forRoute: store?.forRoute,
          mountIndex: store?.mountIndex,
        },
        callback
      );
    },
  };
};
