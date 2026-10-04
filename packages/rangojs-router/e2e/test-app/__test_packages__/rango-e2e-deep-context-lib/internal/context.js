"use client";

import { createContext, createElement, useContext } from "react";

const DeepContext = createContext(undefined);

export function DeepContextProvider({ children, value }) {
  return createElement(DeepContext.Provider, { value }, children);
}

export function useDeepContext() {
  return useContext(DeepContext);
}
