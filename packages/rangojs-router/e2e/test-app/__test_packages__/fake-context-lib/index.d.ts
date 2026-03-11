import type { ReactNode } from "react";

export function ThemeProvider(props: {
  theme: string;
  children: ReactNode;
}): ReactNode;

export function useTheme(): string | null;
