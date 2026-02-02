"use client";

import { useTheme } from "@rangojs/router/theme";

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme, themes } = useTheme();

  return (
    <div className="theme-toggle">
      <p>
        Current theme: <strong>{theme}</strong>
      </p>
      <p>
        Resolved theme: <strong>{resolvedTheme}</strong>
      </p>
      <div className="theme-buttons">
        {themes.map((t) => (
          <button
            key={t}
            onClick={() => setTheme(t)}
            className={theme === t ? "active" : ""}
          >
            {t}
          </button>
        ))}
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .theme-toggle {
              padding: 1rem;
              border: 1px solid var(--border-color, #eee);
              border-radius: 8px;
              margin: 1rem 0;
            }
            .theme-buttons {
              display: flex;
              gap: 0.5rem;
              margin-top: 1rem;
            }
            .theme-buttons button {
              padding: 0.5rem 1rem;
              border: 1px solid #ccc;
              border-radius: 4px;
              background: white;
              cursor: pointer;
              transition: all 0.2s;
            }
            .theme-buttons button:hover {
              background: #f0f0f0;
            }
            .theme-buttons button.active {
              background: #0070f3;
              color: white;
              border-color: #0070f3;
            }

            /* Dark mode styles */
            .dark .theme-toggle {
              border-color: #444;
            }
            .dark .theme-buttons button {
              background: #333;
              color: white;
              border-color: #555;
            }
            .dark .theme-buttons button:hover {
              background: #444;
            }
          `,
        }}
      />
    </div>
  );
}
