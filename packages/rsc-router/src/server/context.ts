import { AsyncLocalStorage } from "node:async_hooks";
import type { ReactNode } from "react";
import type { Handler, MiddlewareFn, ShouldRevalidateFn } from "../types";
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
export type EntryPropSegments = {
  loader: [];
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
    type: "layout" | "parallel" | "route"
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
    getShortCode: (type: "layout" | "parallel" | "route") => {
      const store = context.getStore();
      invariant(store, "No context RSCRouterContext available");
      const counterKey = `short_${type}`;
      store.counters[counterKey] ??= 0;
      const index = store.counters[counterKey];
      store.counters[counterKey] = index + 1;
      const prefix = type === "layout" ? "L" : type === "parallel" ? "P" : "R";
      return `${prefix}${index}`;
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
      const counters = {};
      const manifest = store ? store.manifest : new Map<string, EntryData>();
      return context.run(
        {
          manifest,
          namespace,
          parent: parent || null,
          counters,
        },
        callback
      );
    },
  };
};
