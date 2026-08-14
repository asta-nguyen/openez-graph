import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { ReactNode } from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme | ((prev: Theme) => Theme)) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isClientSide(): boolean {
  try {
    return window !== undefined;
  } catch {
    return false;
  }
}

function isTheme(value: string): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function isThemeUpdater(value: Theme | ((prev: Theme) => Theme)): value is (prev: Theme) => Theme {
  return value instanceof Function;
}

function getSystemTheme(): ResolvedTheme {
  if (!isClientSide()) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? getSystemTheme() : theme;
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (!isClientSide()) return defaultTheme;
    const stored = localStorage.getItem("theme");
    return stored !== null && isTheme(stored) ? stored : defaultTheme;
  });

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme));

  const setTheme = useCallback((value: Theme | ((prev: Theme) => Theme)) => {
    setThemeState((prev) => {
      const next = isThemeUpdater(value) ? value(prev) : value;
      localStorage.setItem("theme", next);
      return next;
    });
  }, []);

  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (theme === "system") {
        const resolved = getSystemTheme();
        setResolvedTheme(resolved);
        document.documentElement.classList.toggle("dark", resolved === "dark");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
