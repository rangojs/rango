import { createElement } from "react";
import { DeepContextProvider } from "./internal/context.js";

export function DeepContextServerWrapper({ children, value }) {
  return createElement(DeepContextProvider, { value }, children);
}
