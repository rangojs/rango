import type { ReactNode } from "react";

export interface DeepContextProviderProps {
  children: ReactNode;
  value: string;
}

export function DeepContextProvider(props: DeepContextProviderProps): ReactNode;
export function useDeepContext(): string | undefined;
