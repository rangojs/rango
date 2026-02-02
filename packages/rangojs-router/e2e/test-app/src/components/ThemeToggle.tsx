"use client";

import { useTheme } from "@rangojs/router/theme";

interface ThemeToggleProps {
  testId: string;
}

export function ThemeToggle({ testId }: ThemeToggleProps) {
  const { theme, setTheme, resolvedTheme, systemTheme, themes } = useTheme();

  return (
    <div data-testid={testId}>
      <div data-testid={`${testId}-current-theme`}>
        Current theme: {theme}
      </div>
      <div data-testid={`${testId}-resolved-theme`}>
        Resolved theme: {resolvedTheme}
      </div>
      <div data-testid={`${testId}-system-theme`}>
        System theme: {systemTheme}
      </div>
      <div data-testid={`${testId}-available-themes`}>
        Available themes: {themes.join(", ")}
      </div>

      <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
        {themes.map((t) => (
          <button
            key={t}
            onClick={() => setTheme(t)}
            data-testid={`${testId}-set-${t}`}
            style={{
              padding: "8px 16px",
              background: theme === t ? "#4CAF50" : "#e0e0e0",
              color: theme === t ? "white" : "black",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
