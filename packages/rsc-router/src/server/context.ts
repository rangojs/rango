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
export type EntryData =
  | {
      type: "route" | "layout";
      id: string;
      parent: EntryData | null;
      handler: ReactNode | Handler<any, any>;
      middleware: MiddlewareFn<any, any>[];
      revalidate: ShouldRevalidateFn<any, any>[];
      parallel: Record<`@${string}`, Handler<any, any> | ReactNode>[];
      layout: EntryData[];
      loader: [];
    }
  | {
      type: "parallel";
      id: string;
      parent: EntryData | null;
      handler: Record<`@${string}`, Handler<any, any> | ReactNode>;
      middleware: MiddlewareFn<any, any>[];
      revalidate: ShouldRevalidateFn<any, any>[];
      parallel: Record<`@${string}`, Handler<any, any> | ReactNode>[];
      layout: EntryData[];
      loader: [];
    };

/**
 * Context stored in AsyncLocalStorage
 */
interface HelperContext {
  manifest: Map<string, EntryData>;
  namespace: string;
  parent: EntryData | null;
  counters: Record<string, number>;
}
export const RSCRouterContext: AsyncLocalStorage<HelperContext> =
  new AsyncLocalStorage<HelperContext>();

export const getContext = (): {
  context: AsyncLocalStorage<HelperContext>;
  getStore: () => HelperContext;
  getParent: () => EntryData | null;
  getOrCreateStore: () => HelperContext;

  getNameForType: (
    type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate"
  ) => string;
  getNextIndex: (
    type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate"
  ) => number;
  run: <T>(
    namespace: string,
    parent: EntryData | null,
    callback: (...args: any[]) => T
  ) => T;
} => {
  const context = RSCRouterContext;

  return {
    context,
    getOrCreateStore: (): HelperContext => {
      let store = RSCRouterContext.getStore();
      if (!store) {
        store = {
          manifest: new Map<string, EntryData>(),
          namespace: "",
          parent: null,
          counters: {},
        };
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
    getNameForType: (
      type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate"
    ) => {
      const store = context.getStore();
      invariant(store, "No context RSCRouterContext available");
      const index = store.counters[type] || 0;
      return `${type}.${index}`;
    },
    getNextIndex: (
      type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate"
    ) => {
      const store = context.getStore();
      invariant(store, "No context RSCRouterContext available");
      store.counters[type] ??= 0;
      const index = store.counters[type];
      store.counters[type]++;
      return index;
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
