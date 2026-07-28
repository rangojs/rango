import type { ReactNode } from "react";

export interface DeepContextServerWrapperProps {
  children: ReactNode;
  value: string;
}

export function DeepContextServerWrapper(
  props: DeepContextServerWrapperProps,
): ReactNode;
